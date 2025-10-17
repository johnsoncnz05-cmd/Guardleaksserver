// server/index.js  (ESM)
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import dotenv from "dotenv";
import cors from "cors";

/* ----------------------------------------------------
   dirname + env
---------------------------------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load ONLY server/.env (do this before reading envs)
dotenv.config({ path: path.resolve(__dirname, ".env") });

// Trim helper for env values with comments
const clean = (v) => (v ?? "").split("#")[0].trim();

/* ----------------------------------------------------
   App
---------------------------------------------------- */
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

/* ----------------------------------------------------
   Auth middleware loader (robust + fallback)
---------------------------------------------------- */
const JWT_SECRET = clean(process.env.JWT_SECRET || "change-me-dev");

let requireAuth = null;
async function loadAuthMiddleware() {
  // try correct path first
  const candidates = ["./middleware/auth.js", "./middle ware/auth.js"];
  for (const p of candidates) {
    try {
      const mod = await import(p).catch(() => null);
      if (mod) {
        const fn = mod.requireAuth || mod.default;
        if (typeof fn === "function") {
          return fn;
        }
      }
    } catch {}
  }

  // fallback: inline JWT verifier so /api/me works even without the file
  console.warn("⚠️  Auth middleware not found; enabling inline JWT verifier.");
  const { default: jwt } = await import("jsonwebtoken");
  return function requireAuthFallback(req, res, next) {
    try {
      const auth = req.get("authorization") || "";
      const token = auth.replace(/^Bearer\s+/i, "");
      if (!token) return res.status(401).json({ ok: false, error: "Missing token" });
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = payload;
      next();
    } catch (e) {
      return res.status(401).json({ ok: false, error: "Invalid token" });
    }
  };
}
requireAuth = await loadAuthMiddleware();

/* ----------------------------------------------------
   Dynamic routes (each is optional; we log if missing)
---------------------------------------------------- */
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

// /api/me (protected endpoint; MUST set req.user for admin UI)
app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: req.user || null });
});

// /api/admin
await mountRoute("/api/admin", "./admin.routes.js");

// /api (main check routes)
await mountRoute("/api", "./check.routes.js");

// /api (contact/inbox)
await mountRoute("/api", "./inbox.routes.js");

/* ----------------------------------------------------
   fetch polyfill (Node < 18)
---------------------------------------------------- */
let fetchFn = globalThis.fetch;
if (typeof fetchFn !== "function") {
  const { default: nodeFetch } = await import("node-fetch");
  fetchFn = nodeFetch;
}

/* ----------------------------------------------------
   PayPal
---------------------------------------------------- */
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

/* ----------------------------------------------------
   Sheets CSV → JSON (published CSV URL)
---------------------------------------------------- */
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

/* ====================================================
   DETAIL ENDPOINT (adds full, unmasked address and ALL columns)
==================================================== */
// small utils
const nonEmpty = (v) => v !== undefined && v !== null && String(v).trim() !== "";
const pick = (...xs) => { for (const x of xs) if (nonEmpty(x)) return x; return ""; };
const digits = (s) => String(s || "").replace(/\D/g, "");
function maskSSN(s) {
  const d = digits(s);
  if (!d) return "";
  const last4 = d.slice(-4);
  return last4 ? `***-**-${last4}` : "***-**-";
}

// expose ALL columns exactly as in your sheet (only SSN masked)
function buildAllFields(r) {
  const HEADERS = [
    "FirstName","MiddleName","LastName","Suffix","FullName","Email","Phone","Address1","City","State","Zip","SSN",
    "DateOfBirth","ID","DriverLicense","EmployeeID","Contact","Card","Sources","RiskLevel","DateAdded","Address2",
    "AdminFee","BenefitTerminationDate","BillingLocation","Carrier","CellPhone","ContributionAmount","Country","County",
    "CoverageAmount","DateOfHire","Department","EffectiveDate","EmployeeClassification","EmployeeId","EmployeeStatus",
    "EmployeeStatusDate","EmploymentTerminationDate","FamilyIndicator","Gender","HomePhone","IsCobra","JobTitle",
    "Location","MRN","MaritalStatus","NSWPremium","OriginalEffectiveDate","PCP","PayrollDeduction","PersonalEmail",
    "PlanEffectiveDate","PlanName","Premium","ReserveCharge","Salary","Type","WorkEmail","WorkPhone",
    "_invalid","address","card","contact","dateAdded","dl","dob","eid","email","id","name","phone","riskLevel","sources","ssn"
  ];
  const ALIASES = {
    ID: ["id","EmployeeId","EmployeeID","MRN"],
    EmployeeID: ["EmployeeId","eid","Employee_ID"],
    Email: ["email","WorkEmail","PersonalEmail"],
    Phone: ["phone","CellPhone","WorkPhone","HomePhone"],
    SSN: ["ssn","Ssn"],
    DateOfBirth: ["dob","DOB","BirthDate"],
    DriverLicense: ["dl","DL","Driver_License"],
    RiskLevel: ["riskLevel"],
    Address1: ["Address","address","AddressLine1","Home Address","HomeAddress"],
    Address2: ["AddressLine2"],
    City: ["city"],
    State: ["state"],
    Zip: ["zip","ZIP","PostalCode"],
    Sources: ["sources"],
    Card: ["card"]
  };

  const out = {};
  for (const key of HEADERS) {
    let val = r[key];
    if (!nonEmpty(val) && ALIASES[key]) {
      for (const alt of ALIASES[key]) {
        if (nonEmpty(r[alt])) { val = r[alt]; break; }
      }
    }
    out[key] = nonEmpty(val) ? String(val) : "";
  }
  if (nonEmpty(out.SSN)) out.SSN = maskSSN(out.SSN); // only SSN masked
  return out;
}

// normalized object for the UI (plus allFields)
function normalizeRow(r) {
  const id = pick(r.id, r.ID, r.EmployeeID, r.EmployeeId, r.MRN);
  const name =
    pick(r.name, r.FullName) ||
    [r.FirstName, r.MiddleName, r.LastName, r.Suffix].filter(nonEmpty).join(" ").replace(/\s+/g, " ");

  const ssnMasked = maskSSN(pick(r.ssn, r.SSN));
  const dob = pick(r.dob, r.DateOfBirth, r.BirthDate, r.DOB);

  const address1 = pick(r.Address1, r.Address, r.address, r.AddressLine1, r["Home Address"], r.HomeAddress);
  const address2 = pick(r.Address2, r.AddressLine2);
  const city = pick(r.City, r.city);
  const state = pick(r.State, r.state);
  const zip = pick(r.Zip, r.zip, r.PostalCode);
  const county = pick(r.County);
  const country = pick(r.Country);
  const homeAddress = [
    [address1, address2].filter(nonEmpty).join(" "),
    [city, state, zip].filter(nonEmpty).join(", "),
  ].filter(nonEmpty).join(" • ");

  const email = pick(r.Email, r.email, r.WorkEmail, r.PersonalEmail);
  const phone = pick(r.Phone, r.phone, r.CellPhone, r.WorkPhone, r.HomePhone);
  const contact = pick(r.Contact, r.contact);

  const employer = pick(r.Employer, r.employer, r.Company, r.Location);
  const jobTitle = pick(r.JobTitle);
  const department = pick(r.Department);
  const employeeId = pick(r.EmployeeID, r.EmployeeId, r.eid);
  const employeeStatus = pick(r.EmployeeStatus);
  const employeeStatusDate = pick(r.EmployeeStatusDate);
  const dateOfHire = pick(r.DateOfHire);
  const employmentTerminationDate = pick(r.EmploymentTerminationDate);
  const employeeClassification = pick(r.EmployeeClassification);

  const workEmail = pick(r.WorkEmail);
  const workPhone = pick(r.WorkPhone);
  const workAddress = pick(r.WorkAddress, r.BillingLocation, r.Location);

  const planName = pick(r.PlanName);
  const planEffectiveDate = pick(r.PlanEffectiveDate);
  const effectiveDate = pick(r.EffectiveDate);
  const originalEffectiveDate = pick(r.OriginalEffectiveDate);
  const benefitTerminationDate = pick(r.BenefitTerminationDate);
  const contributionAmount = pick(r.ContributionAmount);
  const coverageAmount = pick(r.CoverageAmount);
  const premium = pick(r.Premium);
  const reserveCharge = pick(r.ReserveCharge);
  const adminFee = pick(r.AdminFee);
  const payrollDeduction = pick(r.PayrollDeduction);
  const carrier = pick(r.Carrier);
  const pcp = pick(r.PCP);
  const nswPremium = pick(r.NSWPremium);
  const salary = pick(r.Salary);
  const type = pick(r.Type);

  const gender = pick(r.Gender);
  const maritalStatus = pick(r.MaritalStatus);
  const familyIndicator = pick(r.FamilyIndicator);
  const homePhone = pick(r.HomePhone);
  const personalEmail = pick(r.PersonalEmail);
  const mrn = pick(r.MRN);
  const isCobra = pick(r.IsCobra);

  const driverLicense = pick(r.DriverLicense, r.DL, r.dl, r.Driver_License);
  const card = pick(r.Card, r.card);
  const sources = pick(r.Sources, r.sources);
  const riskLevel = (pick(r.RiskLevel, r.riskLevel) || "high").toLowerCase();

  const allFields = buildAllFields(r);

  return {
    ok: true,
    id, name, ssn: ssnMasked, dob,
    email, phone,
    address1, address2, city, state, zip, county, country, homeAddress,
    employer, jobTitle, department, workEmail, workPhone, workAddress,
    driverLicense, card, sources, riskLevel,

    identity: { id, ssn: ssnMasked, dob, driverLicense },
    contact: { email, personalEmail, phone, homePhone, workEmail, workPhone, contact },
    address: {
      address1, address2, city, state, zip, county, country, homeAddress,
      billingLocation: pick(r.BillingLocation), location: pick(r.Location),
    },
    employment: {
      employeeId, employer, jobTitle, department, employeeClassification,
      employeeStatus, employeeStatusDate, dateOfHire, employmentTerminationDate,
      salary, type, mrn, gender, maritalStatus, familyIndicator, isCobra,
    },
    benefits: {
      planName, planEffectiveDate, effectiveDate, originalEffectiveDate,
      benefitTerminationDate, contributionAmount, coverageAmount,
      premium, reserveCharge, adminFee, payrollDeduction, carrier, pcp, nswPremium,
    },

    allFields,
    __raw: r,
  };
}

// GET /api/detail/:id  → collect a record from your admin routes, normalize, force high risk
app.get("/api/detail/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

  const base = `${req.protocol}://${req.get("host")}`;
  const candidates = [
    `${base}/api/admin/detail/${encodeURIComponent(id)}`,
    `${base}/api/admin/record/${encodeURIComponent(id)}`,
  ];

  async function tryJSON(url) {
    try {
      const r = await fetchFn(url);
      const t = await r.text();
      const j = JSON.parse(t || "{}");
      return r.ok ? j : undefined;
    } catch { return undefined; }
  }

  let raw = null;
  for (const u of candidates) {
    raw = await tryJSON(u);
    if (raw) break;
  }

  if (!raw) {
    try {
      const r = await fetchFn(`${base}/api/admin/search?q=${encodeURIComponent(id)}`);
      const t = await r.text();
      const j = JSON.parse(t || "[]");
      if (Array.isArray(j) && j.length) raw = j[0];
    } catch {}
  }

  if (!raw) return res.status(404).json({ ok: false, error: "Not found" });

  const pub = normalizeRow(raw);
  pub.riskLevel = "high"; // present this page as high risk
  res.json(pub);
});

/* ----------------------------------------------------
   Static frontend (Vite build)
---------------------------------------------------- */
const DIST_DIR = path.join(__dirname, "..", "dist");

app.get("/healthz", (_req, res) => res.type("text").send("ok"));
app.use(express.static(DIST_DIR));

// SPA fallback for non-API routes
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

// JSON 404 for API
app.use("/api", (_req, res) => res.status(404).json({ ok: false, error: "Not found" }));

/* ----------------------------------------------------
   Start
---------------------------------------------------- */
const PORT = Number(process.env.PORT || 5062);
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (PayPal=${PAYPAL_MODE})`);
  console.log(`[CORS] ${ALLOWED_ORIGINS.join(", ")}`);
});
