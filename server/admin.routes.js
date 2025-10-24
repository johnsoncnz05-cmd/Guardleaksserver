// server/admin.routes.js  (ESM)
import express from "express";
import fs from "fs/promises";
import fscore from "fs";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import { parse } from "csv-parse";

const router = express.Router();

/* ---------- storage ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "./data");
const BREACH_FILE = path.join(DATA_DIR, "breaches.json");

// Simple settings store (persisted JSON file)
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

async function ensureJson(file, initial) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, JSON.stringify(initial, null, 2), "utf8");
  }
}
await ensureJson(BREACH_FILE, []);
await ensureJson(SETTINGS_FILE, { sheet_csv_url: "" });

async function readSettings() {
  const t = await fs.readFile(SETTINGS_FILE, "utf8").catch(() => "{}");
  try { return JSON.parse(t) || {}; } catch { return {}; }
}
async function writeSettings(obj) {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(obj, null, 2), "utf8");
}
async function getSetting(key, fallback = "") {
  const s = await readSettings();
  return (s && typeof s[key] !== "undefined") ? s[key] : fallback;
}
async function setSetting(key, value) {
  const s = await readSettings();
  s[key] = value;
  await writeSettings(s);
}

async function readJson(file) {
  try {
    const t = await fs.readFile(file, "utf8");
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
async function writeJson(file, rows) {
  await fs.writeFile(file, JSON.stringify(rows, null, 2), "utf8");
}

/* ---------- normalization helpers (match your Check routes) ---------- */
const nonEmpty = (v) => v != null && String(v).trim() !== "";

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
const pick = (obj, keys) => {
  for (const k of keys) {
    const v = obj[k];
    if (nonEmpty(v)) return String(v);
  }
  return "";
};

const listName = (r) =>
  (nonEmpty(r.name) && String(r.name)) ||
  [r.FirstName, r.MiddleName, r.LastName].filter(nonEmpty).join(" ") ||
  String(r.EmployeeName || r.Employee || "(no name)");

const listEmail = (r) =>
  (nonEmpty(r.email) && String(r.email)) ||
  String(r.PersonalEmail || r.WorkEmail || r.Email || "");

const listPhone = (r) =>
  (nonEmpty(r.phone) && String(r.phone)) ||
  String(r.CellPhone || r.WorkPhone || r.HomePhone || r.Phone || "");

function composeAddress(obj) {
  const street = pick(obj, ["address1", "address", "addressline1", "homeaddress"]);
  const city = pick(obj, ["city"]);
  const state = pick(obj, ["state"]);
  const zip = pick(obj, ["zip", "zipcode", "postalcode"]);
  const parts = [street, [city, state].filter(Boolean).join(", "), zip].filter(Boolean);
  return parts.join(", ");
}

function rowToRecord(header, values) {
  const o = {};
  header.forEach((h, i) => (o[norm(h)] = values[i]));

  const first = pick(o, ["firstname", "first"]);
  const middle = pick(o, ["middlename", "middle"]);
  const last = pick(o, ["lastname", "last"]);
  const suffix = pick(o, ["suffix"]);
  const name =
    pick(o, ["name", "employeename", "employee"]) ||
    [first, middle, last, suffix].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

  const email = pick(o, ["personalemail", "workemail", "email"]);
  const phone = pick(o, ["cellphone", "workphone", "homephone", "phone"]);
  const ssn = pick(o, ["ssn", "socialsecuritynumber"]);
  const dob = pick(o, ["dateofbirth", "dob", "birthdate", "birth"]);
  const address = composeAddress(o) || pick(o, ["address1", "address", "addressline1"]);
  const id = pick(o, ["id", "employeeid", "mrn"]) || Math.random().toString(36).slice(2, 10);

  // simple risk
  let risk = "low";
  const hasEmail = !!email, hasPhone = !!phone, hasDOB = !!dob, hasSSN = !!ssn;
  if (hasSSN || (hasDOB && hasEmail && hasPhone)) risk = "high";
  else if (hasDOB || (hasEmail && hasPhone)) risk = "medium";

  return {
    id, name: name || "(no name)", email, phone, ssn, dob, address,
    riskLevel: risk, dateAdded: new Date().toISOString(), sources: ["Upload"],
  };
}

/* ---------- health & reviews (light) ---------- */
router.get("/health", (_req, res) => {
  res.json({ ok: true, db: "connected", payments: "active", time: new Date().toISOString() });
});

router.get("/reviews", (_req, res) => {
  res.json([
    { id: "1", name: "Alex Johnson", rating: 5, message: "Excellent service.", date: "2024-01-14", verified: true },
    { id: "2", name: "Maria Garcia", rating: 4, message: "Very professional.", date: "2024-01-12", verified: true },
  ]);
});

/* ======================= Sheets: helpers & endpoints ======================= */
/** Allow-list Google hosts to avoid SSRF abuse */
function isAllowedSheetsHost(hostname) {
  return (
    /\.google\.com$/i.test(hostname) ||
    /\.googleusercontent\.com$/i.test(hostname) ||
    hostname === "docs.google.com" ||
    hostname === "sheets.googleapis.com"
  );
}

/** Tiny CSV parser (handles quotes, commas, CRLF) so we can parse text */
function parseSimpleCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
      continue;
    }
    if (!inQuotes && ch === ",") { row.push(cur); cur = ""; continue; }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (cur.length || row.length) row.push(cur);
      if (row.length) rows.push(row);
      row = []; cur = "";
      if (ch === "\r" && next === "\n") i++; // CRLF
      continue;
    }
    cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/** Convert various Sheets links to a direct CSV export URL (server-side safety net). */
function toCsvUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());

    // already explicit CSV?
    if (u.searchParams.get("output") === "csv") return u.toString();

    // Standard edit/view: /spreadsheets/d/<ID>/edit#gid=GID
    if (u.hostname === "docs.google.com" && /\/spreadsheets\/d\//.test(u.pathname)) {
      const parts = u.pathname.split("/");
      const idx = parts.indexOf("d");
      const afterD = parts[idx + 1];

      // If it's /d/<ID>/edit...
      if (afterD && afterD !== "e") {
        const id = afterD;
        const gidMatch = (u.hash || "").match(/gid=(\d+)/);
        const gid = gidMatch ? gidMatch[1] : "0";
        return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&id=${id}&gid=${gid}`;
      }

      // Publish-style: /spreadsheets/d/e/<PUBID>/pub[?gid=...]
      if (afterD === "e") {
        const gid = u.searchParams.get("gid");
        u.searchParams.set("output", "csv");
        if (gid) u.searchParams.set("gid", gid);
        return u.toString();
      }
    }

    // gviz API links → convert to export endpoint
    if (u.hostname === "docs.google.com" && /\/spreadsheets\/d\//.test(u.pathname) && u.pathname.includes("/gviz/tq")) {
      const parts = u.pathname.split("/");
      const idx = parts.indexOf("d");
      const id = idx >= 0 ? parts[idx + 1] : null;
      const gid = u.searchParams.get("gid") || "0";
      if (id) return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&id=${id}&gid=${gid}`;
    }

    // otherwise return as-is (still checked against allowlist in routes)
    return u.toString();
  } catch {
    return String(raw || "");
  }
}

/* ---- Persisted Google Sheet URL (GET/POST/DELETE) ---- */
router.get("/sheets-source", async (_req, res) => {
  try {
    const url = await getSetting("sheet_csv_url", "");
    res.json({ ok: true, url });
  } catch {
    res.status(500).json({ ok: false, error: "Failed to read settings" });
  }
});

router.post("/sheets-source", async (req, res) => {
  try {
    const raw = String(req.body?.url || "").trim();
    if (!raw) return res.status(400).json({ ok: false, error: "Missing url" });
    let u;
    try { u = new URL(raw); } catch { return res.status(400).json({ ok: false, error: "Invalid URL" }); }
    if (!["http:", "https:"].includes(u.protocol)) {
      return res.status(400).json({ ok: false, error: "URL must be http/https" });
    }
    if (!isAllowedSheetsHost(u.hostname)) {
      return res.status(400).json({ ok: false, error: "Must be a published Google Sheets link" });
    }
    const csvUrl = toCsvUrl(raw);
    await setSetting("sheet_csv_url", csvUrl);
    res.json({ ok: true, url: csvUrl });
  } catch {
    res.status(500).json({ ok: false, error: "Failed to save" });
  }
});

router.delete("/sheets-source", async (_req, res) => {
  try {
    await setSetting("sheet_csv_url", "");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Failed to clear setting" });
  }
});

/* ---- Aliases for UI: /settings/sheet-url (GET/POST/DELETE) ---- */
router.get("/settings/sheet-url", async (_req, res) => {
  try {
    const url = await getSetting("sheet_csv_url", "");
    res.json({ ok: true, url });
  } catch {
    res.status(500).json({ ok: false, error: "Failed to read settings" });
  }
});

router.post("/settings/sheet-url", async (req, res) => {
  try {
    const raw = String(req.body?.url || "").trim();
    if (!raw) return res.status(400).json({ ok: false, error: "Missing url" });
    let u;
    try { u = new URL(raw); } catch { return res.status(400).json({ ok: false, error: "Invalid URL" }); }
    if (!["http:", "https:"].includes(u.protocol)) {
      return res.status(400).json({ ok: false, error: "Only http/https allowed" });
    }
    if (!isAllowedSheetsHost(u.hostname)) {
      return res.status(400).json({ ok: false, error: "Must be a published Google Sheets link" });
    }
    const csvUrl = toCsvUrl(raw);
    await setSetting("sheet_csv_url", csvUrl);
    res.json({ ok: true, url: csvUrl });
  } catch {
    res.status(500).json({ ok: false, error: "Failed to save" });
  }
});

router.delete("/settings/sheet-url", async (_req, res) => {
  try {
    await setSetting("sheet_csv_url", "");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Failed to delete" });
  }
});

router.get("/sheets-sync", async (req, res) => {
  try {
    let raw = String(req.query.url || "").trim();
    if (!raw) raw = await getSetting("sheet_csv_url", "");
    if (!raw) return res.status(400).json({ ok: false, error: "Missing 'url' and no saved Sheet URL" });

    let u;
    try { u = new URL(raw); }
    catch { return res.status(400).json({ ok: false, error: "Invalid URL" }); }

    if (!["https:", "http:"].includes(u.protocol)) {
      return res.status(400).json({ ok: false, error: "Only http/https allowed" });
    }
    if (!isAllowedSheetsHost(u.hostname)) {
      return res.status(400).json({ ok: false, error: "URL must be a Google Sheets host" });
    }

    // Normalize to a CSV export URL
    const csvUrl = toCsvUrl(u.toString());

    // Use global fetch if available; otherwise lazy-load node-fetch
    let doFetch = globalThis.fetch;
    if (typeof doFetch !== "function") {
      const { default: nodeFetch } = await import("node-fetch");
      doFetch = nodeFetch;
    }

    const r = await doFetch(csvUrl, { headers: { Accept: "text/csv, text/plain, */*" } });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(r.status).json({
        ok: false,
        error:
          (txt && txt.slice(0, 200)) ||
          `Fetch failed (${r.status}). Make sure the Sheet is "File → Share → Publish to the web" or the link is accessible.`,
      });
    }

    const csvText = await r.text();
    const grid = parseSimpleCSV(csvText);

    if (!grid.length) return res.json({ ok: true, headers: [], rows: [], url: csvUrl });

    const headers = grid[0];
    const rows = grid.slice(1).filter(arr => arr.some(c => String(c).trim() !== ""));
    return res.json({ ok: true, headers, rows, url: csvUrl });
  } catch (e) {
    console.error("[/api/admin/sheets-sync] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * POST /api/admin/sheets-import
 * Body: { url?: string, replace?: boolean }
 * Fetches CSV from saved or provided URL, maps rows, and appends (or replaces) breaches.json
 */
router.post("/sheets-import", async (req, res) => {
  try {
    let raw = String(req.body?.url || "").trim();
    if (!raw) raw = await getSetting("sheet_csv_url", "");
    if (!raw) return res.status(400).json({ ok: false, error: "No saved Sheet URL and none provided" });

    let u;
    try { u = new URL(raw); } catch { return res.status(400).json({ ok: false, error: "Invalid URL" }); }
    if (!["http:", "https:"].includes(u.protocol) || !isAllowedSheetsHost(u.hostname)) {
      return res.status(400).json({ ok: false, error: "URL must be a Google Sheets link" });
    }

    const csvUrl = toCsvUrl(u.toString());

    let doFetch = globalThis.fetch;
    if (typeof doFetch !== "function") {
      const { default: nodeFetch } = await import("node-fetch");
      doFetch = nodeFetch;
    }
    const r = await doFetch(csvUrl, { headers: { Accept: "text/csv, text/plain, */*" } });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(r.status).json({ ok: false, error: txt || `Fetch failed (${r.status})` });
    }

    const csvText = await r.text();
    const grid = parseSimpleCSV(csvText);
    if (!grid.length) {
      const existing = await readJson(BREACH_FILE);
      return res.json({ ok: true, added: 0, total: existing.length });
    }

    const headers = grid[0];
    const bodyRows = grid.slice(1).filter(arr => arr.some(c => String(c).trim() !== ""));

    const replace = !!req.body?.replace;
    const rows = replace ? [] : await readJson(BREACH_FILE);
    let added = 0;
    for (const rawRow of bodyRows) {
      const rec = rowToRecord(headers, rawRow);
      rows.push(rec);
      added++;
      if (added % 5000 === 0) await writeJson(BREACH_FILE, rows);
    }
    await writeJson(BREACH_FILE, rows);
    res.json({ ok: true, added, total: rows.length });
  } catch (e) {
    console.error("[/sheets-import] error", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});
/* ===================== end Google Sheets block ===================== */

/* ---------- list / search / detail / delete ---------- */
router.get("/breach-records", async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || "500"), 10) || 500, 5000);
  const offset = Math.max(parseInt(String(req.query.offset || "0"), 10) || 0, 0);
  let rows = await readJson(BREACH_FILE);
  // Ensure every row has a stable 'id' (for selection/deletion)
  let assigned = 0;
  rows = rows.map(r => {
    if (r && (r.id || r.ID)) return r;
    const id = Math.random().toString(36).slice(2, 10);
    assigned++;
    return { id, ...r };
  });
  if (assigned > 0) { await writeJson(BREACH_FILE, rows); }
  res.setHeader("X-Total-Count", String(rows.length));
  res.json(rows.slice(offset, offset + limit));
});

router.get("/breach-detail/:id", async (req, res) => {
  const id = String(req.params.id);
  const rows = await readJson(BREACH_FILE);
  let row = rows.find((r) => String(r.id ?? r.ID ?? "").toLowerCase() === id.toLowerCase());
  if (!row) {
    const idx = Number(id);
    if (!Number.isNaN(idx) && idx >= 0 && idx < rows.length) row = rows[idx];
  }
  if (!row) return res.status(404).json({ ok: false, error: "Not found" });
  // Admin sees raw values
  res.json({
    id: String(row.id ?? ""),
    name: listName(row),
    email: listEmail(row),
    phone: listPhone(row),
    ssn: row.ssn || row.SSN || "",
    address: row.address || row.Address1 || "",
    dob: row.dob || row.DateOfBirth || "",
    sources: Array.isArray(row.sources) ? row.sources : [{ name: "Upload", url: "", dateFound: new Date().toISOString(), credibility: "medium" }],
    riskLevel: row.riskLevel || "medium",
    recommendations: [
      "Rotate passwords and enable MFA on all accounts",
      "Monitor credit reports for 90 days",
      "Freeze credit if suspicious activity is detected",
    ],
  });
});

router.delete("/breach-records/:id", async (req, res) => {
  const id = String(req.params.id);
  const rows = await readJson(BREACH_FILE);
  const next = rows.filter((r) => String(r.id ?? r.ID ?? "") !== id);
  const deleted = rows.length - next.length;
  if (deleted > 0) await writeJson(BREACH_FILE, next);
  res.json({ ok: true, deleted });
});

/* ---------- UPDATED: field-aware search (name/email/phone/address) ---------- */
router.get("/search", async (req, res) => {
  const rawQ = String(req.query.q || "").trim();
  const q = rawQ.toLowerCase();
  const rows = await readJson(BREACH_FILE);
  if (!q) return res.json(rows.slice(0, 500));

  // helpers
  const s = (v) => (v == null ? "" : String(v)).trim();
  const sl = (v) => s(v).toLowerCase();
  const digits = (v) => s(v).replace(/\D/g, "");
  
  // NEW: explicit type override from client (optional)
  const typeParam = String(req.query.type || "").toLowerCase();
  const forcedType = ["name", "email", "phone", "address"].includes(typeParam) ? typeParam : null;
  
  // detect intent
  const looksLikeEmail = /.+@.+\..+/.test(rawQ);
  const qDigits = digits(rawQ);
  const looksLikePhone = qDigits.length >= 7;
  const looksLikeAddress =
    /\d/.test(rawQ) ||
    /(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|pkwy|parkway|apt|suite|unit)\b/i.test(rawQ) ||
    /,\s*[A-Z]{2}\b/.test(rawQ);

  // matchers scoped to relevant fields only
  const inName = (r) => {
    const name = [
      r.name, r.Name, r.employee, r.Employee, r.EmployeeName,
      [r.FirstName, r.MiddleName, r.LastName, r.Suffix].filter(Boolean).join(" ")
    ].filter(Boolean).join(" ");
    return sl(name).includes(q);
    // If you want exact word match, replace the line above with:
    // const re = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
    // return re.test(name || "");
  };

  const inEmail = (r) => {
    const fields = [r.email, r.Email, r.PersonalEmail, r.WorkEmail, r.workEmail, r.personalEmail, r.email1, r.email2]
      .filter(Boolean)
      .map(sl);
    return fields.some((e) => e.includes(q));
  };

  const inPhone = (r) => {
    const fields = [r.phone, r.Phone, r.CellPhone, r.WorkPhone, r.HomePhone, r.Mobile]
      .filter(Boolean)
      .map(digits);
    return fields.some((p) => p.includes(qDigits));
  };

  const inAddress = (r) => {
    const fields = [
      r.address, r.Address, r.Address1, r.AddressLine1, r.HomeAddress, r.AddressText,
      [r.City, r.State, r.Zip].filter(Boolean).join(", "),
      [r.city, r.state, r.zip].filter(Boolean).join(", ")
    ].filter(Boolean).map(sl);
    return fields.some((a) => a.includes(q));
  };

  const predicates = { name: inName, email: inEmail, phone: inPhone, address: inAddress };
  let predicate = forcedType ? predicates[forcedType] :
                  looksLikeEmail ? inEmail :
                  looksLikePhone ? inPhone :
                  looksLikeAddress ? inAddress :
                  inName;

  const out = rows.filter((r) => predicate(r));
  res.json(out.slice(0, 2000));
});

/* ---------- IMPORT: multipart files OR JSON rows ---------- */

// Multer storage to disk (stream from tmp file)
const upload = multer({
  dest: path.join(DATA_DIR, "tmp"),
  limits: {
    fileSize: 512 * 1024 * 1024, // 512MB
    files: 1,
  },
});

// POST /api/admin/import
// - multipart form: {file} -> parse CSV/TSV streaming
// - application/json: {rows: BreachRecord[]} -> append directly
router.post("/import", upload.single("file"), async (req, res) => {
  try {
    const rows = await readJson(BREACH_FILE);

    // JSON {rows: [...]}
    if (req.is("application/json")) {
      const body = req.body || {};
      const incoming = Array.isArray(body.rows) ? body.rows : [];
      if (!incoming.length) return res.status(400).json({ ok: false, error: "No rows" });

      for (const r of incoming) {
        if (!r.id) r.id = Math.random().toString(36).slice(2, 10);
        rows.push(r);
      }
      await writeJson(BREACH_FILE, rows);
      return res.json({ ok: true, added: incoming.length, total: rows.length });
    }

    // Multipart file path
    const filePath = req.file?.path;
    if (!filePath) return res.status(400).json({ ok: false, error: "No file" });

    // Detect delimiter from first KB
    const firstChunk = fscore.readFileSync(filePath, { encoding: "utf8", flag: "r" }).slice(0, 4096);
    const delimiter = firstChunk.indexOf("\t") >= 0 ? "\t" : ",";

    // Stream parse
    const parser = fscore.createReadStream(filePath).pipe(
      parse({
        delimiter,
        relaxColumnCount: true,
        trim: true,
        skip_empty_lines: true,
      })
    );

    let header = null;
    let added = 0;

    for await (const record of parser) {
      if (!header) {
        header = record;
        continue;
      }
      const rec = rowToRecord(header, record);
      rows.push(rec);
      added++;
      if (added % 5000 === 0) await writeJson(BREACH_FILE, rows);
    }

    await writeJson(BREACH_FILE, rows);
    fscore.unlink(filePath, () => {});
    res.json({ ok: true, added, total: rows.length });
  } catch (e) {
    console.error("import error", e);
    res.status(500).json({ ok: false, error: "Import failed" });
  }
});

router.post("/breach-records/bulk-delete", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ ok: false, error: "No ids" });

    const rows = await readJson(BREACH_FILE);
    const next = rows.filter(r => !ids.includes(String(r.id ?? r.ID ?? "")));
    const deleted = rows.length - next.length;
    await writeJson(BREACH_FILE, next);
    res.json({ ok: true, deleted, total: next.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Bulk delete failed" });
  }
});

export default router;
