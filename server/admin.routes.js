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

// helper: first non-empty value where header contains substring
function pickByContains(obj, substrings) {
  const keys = Object.keys(obj);
  for (const sub of substrings) {
    const needle = norm(sub);
    const hit = keys.find(k => norm(k).includes(needle) && String(obj[k] ?? "").trim() !== "");
    if (hit) return String(obj[hit]);
  }
  return "";
}
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

/** Map a CSV row (normalized header map) into your record shape (for Sheet + imports) */
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

  const email = pick(o, ["personalemail", "workemail", "email"]) || pickByContains(o, ["email"]);
  const phone = pick(o, ["cellphone", "workphone", "homephone", "phone"]);
  const ssn = pick(o, ["ssn", "socialsecuritynumber"]);
  const dob = pick(o, ["dateofbirth", "dob", "birthdate", "birth"]);
  const address = composeAddress(o) || pick(o, ["address1", "address", "addressline1"]);
  const id = pick(o, ["id", "employeeid", "mrn", "recordid", "record", "uniqueid", "uid", "rowid"]) || pickByContains(o, ["record id","recordid","id"]) || ""; // may be missing in Sheet

  // simple risk
  let risk = "low";
  const hasEmail = !!email, hasPhone = !!phone, hasDOB = !!dob, hasSSN = !!ssn;
  if (hasSSN || (hasDOB && hasEmail && hasPhone)) risk = "high";
  else if (hasDOB || (hasEmail && hasPhone)) risk = "medium";

  return {
    id, name: name || "(no name)", email, phone, ssn, dob, address,
    // duplicates to satisfy downstream selectors expecting these keys
    Email: email, Phone: phone, SSN: ssn, DateOfBirth: dob,
    PersonalEmail: email, WorkEmail: "",
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
function isAllowedSheetsHost(hostname) {
  return (
    /\.google\.com$/i.test(hostname) ||
    /\.googleusercontent\.com$/i.test(hostname) ||
    hostname === "docs.google.com" ||
    hostname === "sheets.googleapis.com"
  );
}

/** Tiny CSV parser for safety (quotes, commas, CRLF) */
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

/** Convert various Sheets links to a direct CSV export URL */
function toCsvUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());

    if (u.searchParams.get("output") === "csv") return u.toString();

    if (u.hostname === "docs.google.com" && /\/spreadsheets\/d\//.test(u.pathname)) {
      const parts = u.pathname.split("/");
      const idx = parts.indexOf("d");
      const afterD = parts[idx + 1];

      // /spreadsheets/d/<ID>/edit#gid=GID
      if (afterD && afterD !== "e") {
        const id = afterD;
        const gidMatch = (u.hash || "").match(/gid=(\d+)/);
        const gid = gidMatch ? gidMatch[1] : "0";
        return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&id=${id}&gid=${gid}`;
      }

      // /spreadsheets/d/e/<PUBID>/pub[?gid=...]
      if (afterD === "e") {
        const gid = u.searchParams.get("gid");
        u.searchParams.set("output", "csv");
        if (gid) u.searchParams.set("gid", gid);
        return u.toString();
      }
    }

    if (u.hostname === "docs.google.com" && /\/spreadsheets\/d\//.test(u.pathname) && u.pathname.includes("/gviz/tq")) {
      const parts = u.pathname.split("/");
      const idx = parts.indexOf("d");
      const id = idx >= 0 ? parts[idx + 1] : null;
      const gid = u.searchParams.get("gid") || "0";
      if (id) return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&id=${id}&gid=${gid}`;
    }

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

/* Aliases for UI */
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

/* ===================== end Google Sheets settings block ===================== */

/* ===================== LIVE SHEET BACKEND (READ PATHS) ===================== */
/** Optional tiny cache. Set LIVE_SHEET_CACHE_MS=0 for truly immediate reads (default 0). */
const SHEET_CACHE_TTL_MS = Number(process.env.LIVE_SHEET_CACHE_MS ?? "0");
let sheetCache = { url: "", fetchedAt: 0, rows: [] };

function hashId(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(16);
}
function sheetRowToRecord(headers, values) {
  const rec = rowToRecord(headers, values);
  if (!rec.id) {
    const stableKey = [
      rec.name || "",
      rec.email || "",
      rec.phone || "",
      rec.dob || "",
      rec.address || ""
    ].join("|");
    rec.id = "s_" + hashId(stableKey);
  }
  return rec;
}

async function fetchSheetRowsMapped() {
  const saved = await getSetting("sheet_csv_url", "");
  if (!saved) return null;
  const url = toCsvUrl(saved);
  const now = Date.now();

  if (SHEET_CACHE_TTL_MS > 0 && sheetCache.url === url && now - sheetCache.fetchedAt < SHEET_CACHE_TTL_MS) {
    return sheetCache.rows;
  }

  let doFetch = globalThis.fetch;
  if (typeof doFetch !== "function") {
    const { default: nodeFetch } = await import("node-fetch");
    doFetch = nodeFetch;
  }

  const r = await doFetch(url, { headers: { Accept: "text/csv, text/plain, */*" } });
  if (!r.ok) return null;

  const csvText = await r.text();
  const grid = parseSimpleCSV(csvText);
  if (!grid.length) {
    if (SHEET_CACHE_TTL_MS > 0) sheetCache = { url, fetchedAt: now, rows: [] };
    return [];
  }
  const headers = grid[0];
  const bodyRows = grid.slice(1).filter(arr => arr.some(c => String(c).trim() !== ""));
  const mapped = bodyRows.map(row => sheetRowToRecord(headers, row));

  if (SHEET_CACHE_TTL_MS > 0) sheetCache = { url, fetchedAt: now, rows: mapped };
  return mapped;
}

async function getDataRows() {
  try {
    const live = await fetchSheetRowsMapped();
    if (Array.isArray(live)) return live; // live Sheet backend
  } catch (e) {
    console.warn("[getDataRows] live sheet fetch failed; falling back to JSON:", e?.message);
  }
  // Fallback: local JSON (legacy)
  return await readJson(BREACH_FILE);
}

/* ---------- list / search / detail / delete (READ use live Sheet) ---------- */
router.get("/breach-records", async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || "500"), 10) || 500, 5000);
  const offset = Math.max(parseInt(String(req.query.offset || "0"), 10) || 0, 0);
  let rows = await getDataRows();

  // Ensure ID for legacy JSON rows (Sheet rows already have stable ids)
  let assigned = 0;
  rows = rows.map(r => {
    if (r && (r.id || r.ID)) return r;
    const id = "j_" + Math.random().toString(36).slice(2, 10);
    assigned++;
    return { id, ...r };
  });
  if (assigned > 0) { await writeJson(BREACH_FILE, rows).catch(() => {}); }

  res.setHeader("X-Total-Count", String(rows.length));
  res.json(rows.slice(offset, offset + limit));
});

router.get("/breach-detail/:id", async (req, res) => {
  const id = String(req.params.id);
  const rows = await getDataRows();
  let row = rows.find((r) => String(r.id ?? r.ID ?? "").toLowerCase() === id.toLowerCase());
  if (!row) {
    const idx = Number(id);
    if (!Number.isNaN(idx) && idx >= 0 && idx < rows.length) row = rows[idx];
  }
  if (!row) return res.status(404).json({ ok: false, error: "Not found" });
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

/* ---- Field-aware /search with optional type=name|email|phone|address ---- */
router.get("/search", async (req, res) => {
  const rawQ = String(req.query.q || "").trim();
  const q = rawQ.toLowerCase();
  const rows = await getDataRows();
  if (!q) return res.json(rows.slice(0, 500));

  const s = (v) => (v == null ? "" : String(v)).trim();
  const sl = (v) => s(v).toLowerCase();
  const digits = (v) => s(v).replace(/\D/g, "");

  const typeParam = String(req.query.type || "").toLowerCase();
  const forcedType = ["name", "email", "phone", "address"].includes(typeParam) ? typeParam : null;

  const looksLikeEmail = /.+@.+\..+/.test(rawQ);
  const qDigits = digits(rawQ);
  const looksLikePhone = qDigits.length >= 7;
  const looksLikeAddress =
    /\d/.test(rawQ) ||
    /(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|pkwy|parkway|apt|suite|unit)\b/i.test(rawQ) ||
    /,\s*[A-Z]{2}\b/.test(rawQ);

  const inName = (r) => {
    const name = [
      r.name, r.Name, r.employee, r.Employee, r.EmployeeName,
      [r.FirstName, r.MiddleName, r.LastName, r.Suffix].filter(Boolean).join(" ")
    ].filter(Boolean).join(" ");
    return sl(name).includes(q);
  };

  const inEmail = (r) => {
    const fields = [r.email, r.Email, r.PersonalEmail, r.WorkEmail, r.workEmail, r.personalEmail, r.email1, r.email2]
      .filter(Boolean).map(sl);
    return fields.some((e) => e.includes(q));
  };

  const inPhone = (r) => {
    const fields = [r.phone, r.Phone, r.CellPhone, r.WorkPhone, r.HomePhone, r.Mobile]
      .filter(Boolean).map(digits);
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

/* ---------- IMPORT/DELETE (kept; operate on local JSON; not used in live mode) ---------- */

// Multer storage to disk (stream from tmp file)
const upload = multer({
  dest: path.join(DATA_DIR, "tmp"),
  limits: {
    fileSize: 512 * 1024 * 1024, // 512MB
    files: 1,
  },
});

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

    const filePath = req.file?.path;
    if (!filePath) return res.status(400).json({ ok: false, error: "No file" });

    const firstChunk = fscore.readFileSync(filePath, { encoding: "utf8", flag: "r" }).slice(0, 4096);
    const delimiter = firstChunk.indexOf("\t") >= 0 ? "\t" : ",";

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

router.get("/breach-records-legacy", async (_req, res) => {
  const rows = await readJson(BREACH_FILE);
  res.json(rows);
});

router.delete("/breach-records/:id", async (req, res) => {
  const id = String(req.params.id);
  const rows = await readJson(BREACH_FILE);
  const next = rows.filter((r) => String(r.id ?? r.ID ?? "") !== id);
  const deleted = rows.length - next.length;
  if (deleted > 0) await writeJson(BREACH_FILE, next);
  res.json({ ok: true, deleted });
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

