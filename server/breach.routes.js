import express from "express";
import fs from "fs/promises";
import fscore from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = express.Router();

/* ------------------- storage paths ------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "./data");
const BREACH_FILE = path.join(DATA_DIR, "breaches.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

/* ------------------- tiny fs helpers ------------------- */
async function ensureJson(file, initial) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { await fs.access(file); } catch { await fs.writeFile(file, JSON.stringify(initial, null, 2), "utf8"); }
}
await ensureJson(BREACH_FILE, []);
await ensureJson(SETTINGS_FILE, { sheet_csv_url: "" });

async function readJson(file) {
  try { const t = await fs.readFile(file, "utf8"); const v = JSON.parse(t); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

/* ------------------- settings helpers ------------------- */
async function readSettings() { try { return JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")) || {}; } catch { return {}; } }
async function getSetting(key, fallback = "") { const s = await readSettings(); return (s && typeof s[key] !== "undefined") ? s[key] : fallback; }

/* ------------------- CSV + Sheets helpers ------------------- */
function parseSimpleCSV(text) {
  const rows = []; let row = []; let cur = ""; let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (ch === '"') { if (inQuotes && next === '"') { cur += '"'; i++; } else { inQuotes = !inQuotes; } continue; }
    if (!inQuotes && ch === ",") { row.push(cur); cur = ""; continue; }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (cur.length || row.length) row.push(cur);
      if (row.length) rows.push(row);
      row = []; cur = "";
      if (ch === "\r" && next === "\n") i++;
      continue;
    }
    cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function toCsvUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    if (u.searchParams.get("output") === "csv") return u.toString();

    if (u.hostname === "docs.google.com" && /\/spreadsheets\/d\//.test(u.pathname)) {
      const parts = u.pathname.split("/");
      const idx = parts.indexOf("d");
      const afterD = parts[idx + 1];

      if (afterD && afterD !== "e") {
        const id = afterD;
        const gidMatch = (u.hash || "").match(/gid=(\d+)/);
        const gid = gidMatch ? gidMatch[1] : "0";
        return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&id=${id}&gid=${gid}`;
      }
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
  } catch { return String(raw || ""); }
}

/* Map a CSV row to a record and also preserve original headers in `columns`. */
const normKey = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
const nonEmpty = (v) => v != null && String(v).trim() !== "";
const pick = (obj, keys) => { for (const k of keys) { if (nonEmpty(obj[k])) return String(obj[k]); } return ""; };

function rowToRecord(headers, values) {
  const original = {}; headers.forEach((h, i) => (original[h] = values[i]));
  const o = {}; headers.forEach((h, i) => (o[normKey(h)] = values[i]));

  const first = pick(o, ["firstname","first"]);
  const middle = pick(o, ["middlename","middle"]);
  const last = pick(o, ["lastname","last"]);
  const suffix = pick(o, ["suffix"]);
  const name =
    pick(o, ["name","employeename","employee"]) ||
    [first, middle, last, suffix].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

  const email = pick(o, ["personalemail","workemail","email"]);
  const phone = pick(o, ["phonenumber","cellphone","workphone","homephone","phone"]);
  const ssn = pick(o, ["ssn","socialsecuritynumber"]);
  const dob = pick(o, ["birthdate","dateofbirth","dob","birth"]);
  const address = pick(o, ["address","address1","addressline1","homeaddress"]);

  const id = pick(o, ["id","recordid","employeeid","mrn"]);
  let risk = "low";
  const hasEmail = !!email, hasPhone = !!phone, hasDOB = !!dob, hasSSN = !!ssn;
  if (hasSSN || (hasDOB && hasEmail && hasPhone)) risk = "high";
  else if (hasDOB || (hasEmail && hasPhone)) risk = "medium";

  return {
    id,
    name: name || "(no name)",
    email, phone, ssn, dob, address,
    riskLevel: risk,
    dateAdded: new Date().toISOString(),
    sources: ["Upload"],
    Email: email || original["Email"] || "",
    PersonalEmail: original["Email 1"] || original["PersonalEmail"] || "",
    WorkEmail: original["WorkEmail"] || "",
    columns: original,
  };
}

function hashId(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i); return (h >>> 0).toString(16); }
function sheetRowToRecord(headers, values) {
  const rec = rowToRecord(headers, values);
  if (!rec.id) {
    const stableKey = [rec.name||"", rec.email||"", rec.phone||"", rec.dob||"", rec.address||""].join("|");
    rec.id = "s_" + hashId(stableKey);
  }
  return rec;
}

/* Live-Sheet backend (same as admin) */
const SHEET_CACHE_TTL_MS = Number(process.env.LIVE_SHEET_CACHE_MS ?? "0");
let sheetCache = { url: "", fetchedAt: 0, rows: [] };

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

  const grid = parseSimpleCSV(await r.text());
  if (!grid.length) { if (SHEET_CACHE_TTL_MS > 0) sheetCache = { url, fetchedAt: now, rows: [] }; return []; }
  const headers = grid[0];
  const mapped = grid.slice(1)
    .filter(arr => arr.some(c => String(c).trim() !== ""))
    .map(row => sheetRowToRecord(headers, row));

  if (SHEET_CACHE_TTL_MS > 0) sheetCache = { url, fetchedAt: now, rows: mapped };
  return mapped;
}

async function getDataRows() {
  try {
    const live = await fetchSheetRowsMapped();
    if (Array.isArray(live)) return live;
  } catch { /* fall back */ }
  return await readJson(BREACH_FILE);
}

/* ------------------- masking & helpers ------------------- */
const maskEmail = (v) => {
  const s = String(v || "").trim();
  if (!s.includes("@")) return s.replace(/.(?=.{2})/g, "•");
  const [user, domain] = s.split("@");
  if (!user || !domain) return s;
  const keepTail = Math.min(3, Math.max(0, user.length - 1));
  const head = user.slice(0, 1);
  const tail = keepTail ? user.slice(-keepTail) : "";
  const midLen = Math.max(1, user.length - (1 + keepTail));
  return `${head}${"•".repeat(midLen)}${tail}@${domain}`;
};
const maskPhone = (v) => {
  const digits = String(v || "").replace(/\D+/g, "");
  if (!digits) return "";
  const hasCC = digits.length > 10;
  const cc = hasCC ? `+${digits.slice(0, digits.length - 10)} ` : "";
  const last10 = (hasCC ? digits.slice(-10) : digits.padStart(10, "0")).slice(-10);
  const area = last10.slice(0, 3);
  const last3 = last10.slice(-3);
  const midLen = Math.max(1, last10.length - 6);
  return `${cc}(${area}) ${"*".repeat(midLen)}${last3}`;
};
const maskSSNFirst2Last3 = (v) => {
  const d = String(v || "").replace(/\D+/g, "");
  if (!d) return "***-**-***";
  if (d.length < 5) return `***-**-${d.slice(-3).padStart(3, "*")}`;
  const first2 = d.slice(0, 2);
  const last3 = d.slice(-3);
  return `${first2}*-**-***${last3}`;
};
const maskAddress = (v) => {
  const s = String(v || "");
  if (!s) return "";
  const parts = s.split(",");
  if (parts.length <= 1) return s.replace(/^\d+/, "***");
  parts[0] = parts[0].replace(/^\s*\d+/, (m) => "*".repeat(Math.max(3, m.length)));
  return parts.join(", ");
};
function toMMDDYYYYDigits(v) {
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${mm}${dd}${yyyy}`;
  }
  const m = String(v || "").match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (m) return `${m[2]}${m[3]}${m[1]}`;
  return String(v || "");
}

const isEmailKey = (k) => String(k).toLowerCase().includes("email");
const isPhoneKey = (k) => { const lk = String(k).toLowerCase(); return lk.includes("phone") || lk.includes("phonenumber") || lk.includes("mobile") || lk.includes("cell"); };
const isSSNKey   = (k) => { const lk = String(k).toLowerCase(); return lk === "ssn" || lk.includes("social"); };
const isDOBKey   = (k) => { const lk = String(k).toLowerCase(); return lk.includes("birthdate") || lk.includes("dateofbirth") || lk === "dob" || lk.includes("birth"); };
const isAddressKey = (k) => String(k).toLowerCase().includes("address");
const isDLKey    = (k) => { const lk = String(k).toLowerCase(); return lk === "dl" || (lk.includes("driver") && lk.includes("license")); };
const isGenericIDKey = (k) => String(k).toLowerCase() === "id";

const maskDL = (v) => {
  const s = String(v || ""); const d = s.replace(/\W+/g, ""); if (!d) return s;
  const tail = d.slice(-3);
  return `${"*".repeat(Math.max(3, d.length - 3))}${tail}`;
};
const maskGenericID = (v) => {
  const s = String(v || ""); const d = s.replace(/\W+/g, ""); if (!d) return s;
  const tail = d.slice(-3);
  return `${"*".repeat(Math.max(3, d.length - 3))}${tail}`;
};

function collectEmails(row) {
  const seen = new Set();
  const visit = (obj) => { for (const [k, v] of Object.entries(obj || {})) if (v && isEmailKey(k)) seen.add(String(v).trim()); };
  visit(row); visit(row.columns);
  return Array.from(seen);
}
function pickPrimaryEmail(row) {
  const arr = collectEmails(row);
  const pref = [row.PersonalEmail, row.WorkEmail, row.Email, row.email].map((x)=>String(x||"").trim()).filter(Boolean);
  for (const p of pref) if (arr.includes(p)) return p;
  return arr[0] || "";
}
function pickPhone(row) {
  const basic = row.phone || row.Phone || row.CellPhone || row.WorkPhone || row.HomePhone || "";
  if (basic) return basic;
  for (const [k, v] of Object.entries(row.columns || {})) {
    const lk = String(k).toLowerCase();
    if ((lk.includes("phone") || lk.includes("phonenumber") || lk.includes("mobile") || lk.includes("cell")) && v) return v;
  }
  return "";
}
const pickAddress = (row) => row.address || row.Address1 || row.Address || row.HomeAddress || (row.columns?.Address) || "";
const pickDOB = (row) => row.BirthDate || row.DateOfBirth || row.dob || row.DOB || row.birthdate || "";
const pickSSN = (row) => row.ssn || row.SSN || row.columns?.SSN || "";

function inferRisk(row) {
  const hasSSN = !!pickSSN(row);
  const hasDOB = !!pickDOB(row);
  const hasPhone = !!pickPhone(row);
  const hasEmail = collectEmails(row).length > 0;
  if (hasSSN || (hasDOB && hasEmail && hasPhone)) return "high";
  if ((hasEmail && hasPhone) || hasDOB) return "medium";
  return "low";
}
function inferSources(raw) {
  const srcs = raw.sources;
  if (Array.isArray(srcs)) return srcs.map((s, i) => ({
    name: String(s?.name || s || `Source ${i + 1}`),
    url: String(s?.url || ""),
    dateFound: raw.dateAdded || raw.DateAdded || new Date().toISOString(),
    credibility: ["high","medium","low"].includes(String(s?.credibility)) ? s.credibility : "medium",
  }));
  return [{ name: "Unknown source", url: "", dateFound: raw.dateAdded || raw.DateAdded || new Date().toISOString(), credibility: "medium" }];
}
function potentialMisuse(row) {
  const risks = [];
  if (collectEmails(row).length) risks.push("Phishing & account takeover via email");
  if (pickPhone(row)) risks.push("Smishing & SIM-swap risk");
  if (pickAddress(row)) risks.push("Targeted scams using address");
  if (pickDOB(row)) risks.push("Identity verification bypass via DOB");
  if (pickSSN(row)) risks.push("Full identity theft risk");
  return risks.length ? risks : ["General privacy risk from exposed PII"];
}

function buildDisplay(row) {
  const out = {};
  const put = (k, v) => {
    if (v == null || v === "") return;
    if (isEmailKey(k)) out[k] = maskEmail(v);
    else if (isPhoneKey(k)) out[k] = maskPhone(v);
    else if (isSSNKey(k)) out[k] = maskSSNFirst2Last3(v);
    else if (isDOBKey(k)) out[k] = toMMDDYYYYDigits(v);
    else if (isAddressKey(k)) out[k] = maskAddress(v);
    else if (isDLKey(k)) out[k] = maskDL(v);
    else if (isGenericIDKey(k) && k !== "id") out[k] = maskGenericID(v);
    else out[k] = v;
  };
  for (const [k, v] of Object.entries(row)) if (k !== "columns") put(k, v);
  for (const [k, v] of Object.entries(row.columns || {})) if (out[k] == null) put(k, v);
  const emails = []; const visit = (obj) => { for (const [k, v] of Object.entries(obj || {})) { if (isEmailKey(k) && v) emails.push(String(v)); } };
  visit(row); visit(row.columns); if (emails.length) out.emails = [...new Set(emails)].map(maskEmail);
  return out;
}

/* ------------------- robust id match ------------------- */
function findRecord(rows, id) {
  const needle = String(id).toLowerCase();
  let row = rows.find(r => String(r.id ?? r.ID ?? "").toLowerCase() === needle);
  if (row) return row;
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) { if (k === "columns") continue; if (String(v).toLowerCase() === needle) return r; }
    for (const [k, v] of Object.entries(r.columns || {})) { if (String(v).toLowerCase() === needle) return r; }
  }
  const idx = Number(id);
  if (!Number.isNaN(idx) && idx >= 0 && idx < rows.length) return rows[idx];
  return null;
}

/* ------------------- detail handler + aliases ------------------- */
async function handleDetail(req, res) {
  const id = String(req.params.id);
  const rows = await getDataRows();          // <— LIVE SHEET (fallback to JSON)
  const row = findRecord(rows, id);
  if (!row) return res.status(404).json({ ok: false, error: "Not found" });

  const payload = {
    id: String(row.id ?? row.ID ?? ""),
    name: row.name || row.Name || "(no name)",
    email: maskEmail(pickPrimaryEmail(row)),
    emails: collectEmails(row).map(maskEmail),
    phone: maskPhone(pickPhone(row)),
    ssn: maskSSNFirst2Last3(pickSSN(row)),
    address: maskAddress(pickAddress(row)),
    dobFull: toMMDDYYYYDigits(pickDOB(row)),
    sources: inferSources(row),
    riskLevel: row.riskLevel || inferRisk(row),
    recommendations: [
      "Rotate passwords and enable MFA on all important accounts",
      "Place a fraud alert and monitor your credit reports",
      "Do not respond to unsolicited links or attachments",
    ],
    potentialMisuse: potentialMisuse(row),
    dateAdded: row.dateAdded || row.DateAdded || null,
    contactLink: `/contact?topic=removal&ref=${encodeURIComponent(String(row.id ?? ""))}`,
    columns: row.columns || {},
    display: buildDisplay(row),
    ok: true,
  };
  res.json(payload);
}

router.get("/detail/:id", handleDetail);
router.get("/breach-detail/:id", handleDetail);
router.get("/leak/:id", handleDetail);

export default router;
