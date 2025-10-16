// server/index.js  (ESM)
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import dotenv from "dotenv";
import cors from "cors";

// ----------------------------------------------------
// dirname + env
// ----------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load ONLY server/.env (do this before reading envs)
dotenv.config({ path: path.resolve(__dirname, ".env") });

// Trim helper for env values with comments
const clean = (v) => (v ?? "").split("#")[0].trim();

// ----------------------------------------------------
// App
// ----------------------------------------------------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "200mb" }));
app.use(express.urlencoded({ extended: true, limit: "200mb" }));

// CORS (prod + dev ports)
const defaultOrigins = [
  "https://guardleaks.com",
  "https://www.guardleaks.com",
  "http://localhost:5173", // vite default
  "http://localhost:8081", // your dev port
  "http://127.0.0.1:8081",
];
const extraOrigins = clean(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = Array.from(new Set([...defaultOrigins, ...extraOrigins]));

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl
      cb(null, ALLOWED_ORIGINS.includes(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  })
);

// Optional HTTPS redirect when behind a proxy (Render)
if (String(process.env.FORCE_HTTPS || "").toLowerCase() === "true") {
  app.use((req, res, next) => {
    if (req.get("x-forwarded-proto") === "http") {
      return res.redirect(301, `https://${req.get("host")}${req.originalUrl}`);
    }
    next();
  });
}

// ----------------------------------------------------
// Auth middleware (robust import)
// ----------------------------------------------------
let requireAuth = (req, _res, next) => next();
try {
  // Try original path with space (if that’s really in your tree)
  const mod = await import("./middle ware/auth.js").catch(() => null);
  if (mod) requireAuth = mod.requireAuth || mod.default || requireAuth;
} catch {}
if (requireAuth === ((req, _res, next) => next())) {
  // Try common path without space
  try {
    const mod2 = await import("./middleware/auth.js").catch(() => null);
    if (mod2) requireAuth = mod2.requireAuth || mod2.default || requireAuth;
  } catch {}
}
if (requireAuth === ((req, _res, next) => next())) {
  console.warn("⚠️  No auth middleware found (using pass-through).");
}

// ----------------------------------------------------
// Dynamic routes (each is optional; we log if missing)
// ----------------------------------------------------
async function mountRoute(mountPath, file) {
  try {
    const mod = await import(file);
    const router = mod.default || mod.router || mod;
    app.use(mountPath, router);
    console.log(`[routes] mounted ${file} at ${mountPath}`);
  } catch (e) {
    console.warn(`[routes] skipped ${file}: ${e?.message || e}`);
  }
}

// /api/auth
await mountRoute("/api/auth", "./auth.routes.js");
// /api/me (example protected endpoint)
app.get("/api/me", requireAuth, (req, res) => res.json({ user: req.user || null }));
// /api/admin
await mountRoute("/api/admin", "./admin.routes.js");
// /api (main check routes)
await mountRoute("/api", "./check.routes.js");
// /api (contact/inbox)
await mountRoute("/api", "./inbox.routes.js");

// ----------------------------------------------------
// fetch polyfill (Node < 18)
// ----------------------------------------------------
let fetchFn = globalThis.fetch;
if (typeof fetchFn !== "function") {
  const { default: nodeFetch } = await import("node-fetch");
  fetchFn = nodeFetch;
}

// ----------------------------------------------------
// PayPal
// ----------------------------------------------------
const PAYPAL_MODE = clean(process.env.PAYPAL_MODE) === "live" ? "live" : "sandbox";
const PAYPAL_CLIENT_ID = clean(process.env.PAYPAL_CLIENT_ID);
const PAYPAL_SECRET = clean(process.env.PAYPAL_SECRET);

const PP_BASE =
  PAYPAL_MODE === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
  console.warn("⚠️  Missing PAYPAL_CLIENT_ID or PAYPAL_SECRET in server/.env");
} else {
  console.log(`[PayPal] mode=${PAYPAL_MODE} client=${PAYPAL_CLIENT_ID.slice(0, 8)}…`);
}

async function getAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    throw new Error("PayPal not configured");
  }
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64");
  const res = await fetchFn(`${PP_BASE}/v1/oauth2/token`, {
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

app.post("/api/payments/create-order", async (req, res) => {
  try {
    const { amount, currency = "USD", label = "Support" } = req.body || {};
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid amount" });
    }
    const token = await getAccessToken();
    const r = await fetchFn(`${PP_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: currency, value: n.toFixed(2) }, description: label }],
        application_context: { brand_name: "GuardLeaks", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" },
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
    console.error("create-order error:", e?.message || e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.post("/api/payments/capture-order", async (req, res) => {
  try {
    const { orderID } = req.body || {};
    if (!orderID) return res.status(400).json({ ok: false, error: "Missing orderID" });
    const token = await getAccessToken();
    const r = await fetchFn(`${PP_BASE}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = j?.message || (await r.text().catch(() => "")) || "Capture failed";
      console.error("[PayPal] capture failed:", r.status, msg);
      return res.status(500).json({ ok: false, error: msg });
    }
    const ref = j?.purchase_units?.[0]?.payments?.captures?.[0]?.id || j?.id || orderID;
    res.json({ ok: true, token: ref, details: j });
  } catch (e) {
    console.error("capture-order error:", e?.message || e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ----------------------------------------------------
// Sheets CSV → JSON (published CSV URL)
// ----------------------------------------------------
function parseCsvLoosely(text) {
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
      if (ch === "\r" && next === "\n") i++;
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
    const rows = grid.slice(1).filter((arr) => arr.some((c) => String(c).trim() !== ""));
    res.json({ headers, rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e?.message || "sheet fetch failed" });
  }
});

// ----------------------------------------------------
// Static frontend (Vite build)
// ----------------------------------------------------
const DIST_DIR = path.join(__dirname, "..", "dist");

app.get("/healthz", (_req, res) => res.type("text").send("ok"));
app.use(express.static(DIST_DIR));

// SPA fallback for non-API routes
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

// JSON 404 for API
app.use("/api", (_req, res) => res.status(404).json({ ok: false, error: "Not found" }));

// ----------------------------------------------------
// Start
// ----------------------------------------------------
const PORT = Number(process.env.PORT || 5062);
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (PayPal=${PAYPAL_MODE})`);
  console.log(`[CORS] ${ALLOWED_ORIGINS.join(", ")}`);
});
