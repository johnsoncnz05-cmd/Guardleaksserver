// server/index.js  (ESM)
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { requireAuth } from "./middleware/auth.js"; // stays as-is

// -------- dirname helpers --------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🔐 Load ONLY server/.env (must happen BEFORE reading env vars)
dotenv.config({ path: path.resolve(__dirname, ".env") });

// Small helper to trim accidental trailing comments/spaces
const clean = (v) => (v ?? "").split("#")[0].trim();

const PAYPAL_MODE = clean(process.env.PAYPAL_MODE) === "live" ? "live" : "sandbox";
const PAYPAL_CLIENT_ID = clean(process.env.PAYPAL_CLIENT_ID);
const PAYPAL_SECRET = clean(process.env.PAYPAL_SECRET);

// ---- App init (create app BEFORE using any app.use)
const app = express();

// If running behind Render/other proxies, this helps with HTTPS + IPs
app.set("trust proxy", 1);

// Core parsers
app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ extended: true, limit: "200mb" }));

// CORS (runs AFTER app is created)
app.use(
  cors({
    origin: [
      "https://guardleaks.com",
      "https://www.guardleaks.com",
      "http://localhost:5173",
      "http://localhost:8081",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Optional: force HTTPS in production (set FORCE_HTTPS=true on Render if desired)
if (String(process.env.FORCE_HTTPS || "").toLowerCase() === "true") {
  app.use((req, res, next) => {
    if (req.get("x-forwarded-proto") === "http") {
      return res.redirect(301, `https://${req.get("host")}${req.originalUrl}`);
    }
    next();
  });
}

// -------- dynamic route imports (kept as you had) --------
{
  const { default: authRoutes } = await import("./auth.routes.js");
  const { default: adminRoutes } = await import("./admin.routes.js");
  const { default: checkRoutes } = await import("./check.routes.js");
  const { default: inboxRoutes } = await import("./inbox.routes.js"); // ← add this

  app.use("/api/auth", authRoutes);
  app.get("/api/me", requireAuth, (req, res) => res.json({ user: req.user }));
  app.use("/api/admin", adminRoutes);
  app.use("/api", checkRoutes);

  app.use("/api", inboxRoutes); // ← mount after auth/check (public/contact + admin/inbox)
}

// -------- fetch polyfill for Node < 18 --------
const hasFetch = typeof globalThis.fetch === "function";
let fetchFn = globalThis.fetch;
if (!hasFetch) {
  const { default: nodeFetch } = await import("node-fetch");
  fetchFn = nodeFetch;
}

// -------- PayPal config (index-only) --------
const BASE =
  PAYPAL_MODE === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
  console.warn("⚠️  Missing PAYPAL_CLIENT_ID or PAYPAL_SECRET in server/.env");
} else {
  console.log(`[PayPal] mode=${PAYPAL_MODE} client=${PAYPAL_CLIENT_ID.slice(0, 8)}…`);
}

async function getAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64");
  const res = await fetchFn(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OAuth error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return data.access_token;
}

// -------- Payments endpoints (kept here) --------
app.post("/api/payments/create-order", async (req, res) => {
  try {
    const { amount, currency = "USD", label = "Support" } = req.body || {};
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid amount" });
    }
    const token = await getAccessToken();
    const r = await fetchFn(`${BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: currency, value: n.toFixed(2) },
            description: label,
          },
        ],
        application_context: {
          brand_name: "GuardLeaks",
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
        },
      }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.id) {
      const msg = j?.message || (await r.text().catch(() => "")) || "Could not create order";
      console.error("[PayPal] create-order failed:", r.status, msg);
      return res.status(500).json({ ok: false, error: msg });
    }
    res.json({ ok: true, orderID: j.id });
  } catch (e) {
    console.error("create-order error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.post("/api/payments/capture-order", async (req, res) => {
  try {
    const { orderID } = req.body || {};
    if (!orderID) return res.status(400).json({ ok: false, error: "Missing orderID" });

    const token = await getAccessToken();
    const r = await fetchFn(`${BASE}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = j?.message || (await r.text().catch(() => "")) || "Capture failed";
      console.error("[PayPal] capture failed:", r.status, msg);
      return res.status(500).json({ ok: false, error: msg });
    }

    const ref =
      j?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
      j?.id ||
      orderID;

    res.json({ ok: true, token: ref, details: j });
  } catch (e) {
    console.error("capture-order error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// -------- Google Sheet CSV -> JSON rows (no auth; published link) --------
function parseCsvLoosely(text) {
  // simple CSV splitter; good enough for Sheets "Publish to web" CSV
  const rows = [];
  let cur = "", row = [], inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
      continue;
    }
    if (!inQuotes && ch === ",") { row.push(cur); cur = ""; continue; }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (cur.length || row.length) row.push(cur);
      if (row.length) rows.push(row);
      cur = ""; row = [];
      if (ch === "\r" && next === "\n") i++; // CRLF
      continue;
    }
    cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

app.get("/api/admin/sheets-sync", async (req, res) => {
  try {
    const url = String(req.query.url || "");
    if (!url) return res.status(400).json({ error: "url required (published CSV link)" });

    const r = await fetchFn(url);
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(500).json({ error: `CSV fetch failed ${r.status}`, detail: txt.slice(0, 300) });
    }
    const csv = await r.text();
    const grid = parseCsvLoosely(csv);
    const headers = grid[0] || [];
    const rows = grid.slice(1).filter(arr => arr.some(c => String(c).trim() !== ""));

    res.json({ headers, rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e?.message || "sheet fetch failed" });
  }
});

// ---------- STATIC FRONTEND (Vite build) ----------
const DIST_DIR = path.join(__dirname, "..", "dist");

// Small health check (good for Render probes)
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// Serve static files from Vite build
app.use(express.static(DIST_DIR));

// SPA fallback: send index.html for any non-API route
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

// JSON 404 for API
app.use("/api", (_req, res) => res.status(404).json({ ok: false, error: "Not found" }));

// Start
const PORT = Number(process.env.PORT || 5062);
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (PayPal=${PAYPAL_MODE})`);
});
