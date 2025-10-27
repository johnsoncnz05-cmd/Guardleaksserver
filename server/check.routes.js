import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const router = express.Router();

/* ---------------- paths & tiny fs ---------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "./data");
const BREACH_FILE = path.join(DATA_DIR, "breaches.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

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
async function readSettings() { try { return JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")) || {}; } catch { return {}; } }
async function getSetting(key, fallback = "") { const s = await readSettings(); return (s && typeof s[key] !== "undefined") ? s[key] : fallback; }

/* ---------------- sheets helpers ---------------- */
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
      const p = u.pathname.split("/"); const idx = p.indexOf("d"); const afterD = p[idx + 1];
      if (afterD && afterD !== "e") {
        const id = afterD; const gm = (u.hash || "").match(/gid=(\d+)/); const gid = gm ? gm[1] : "0";
        return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&id=${id}&gid=${gid}`;
      }
      if (afterD === "e") { const gid = u.searchParams.get("gid"); u.searchParams.set("output", "csv"); if (gid) u.searchParams.set("gid", gid); return u.toString(); }
    }
    if (u.hostname === "docs.google.com" && /\/spreadsheets\/d\//.test(u.pathname) && u.pathname.includes("/gviz/tq")) {
      const p = u.pathname.split("/"); const idx = p.indexOf("d"); const id = idx >= 0 ? p[idx + 1] : null;
      const gid = u.searchParams.get("gid") || "0";
      if (id) return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&id=${id}&gid=${gid}`;
    }
    return u.toString();
  } catch { return String(raw || ""); }
}

/* map sheet row */
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
  if (ssn || (dob && email && phone)) risk = "high";
  else if (dob || (email && phone)) risk = "medium";

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
  try { const live = await fetchSheetRowsMapped(); if (Array.isArray(live)) return live; }
  catch { /* fall back */ }
  return await readJson(BREACH_FILE);
}

/* ---------------- masking & helpers ---------------- */
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
  const s = String(v || ""); if (!s) return "";
  const parts = s.split(","); if (parts.length <= 1) return s.replace(/^\d+/, "***");
  parts[0] = parts[0].replace(/^\s*\d+/, (m) => "*".repeat(Math.max(3, m.length)));
  return parts.join(", ");
};

const isEmailKey = (k) => String(k).toLowerCase().includes("email");
const isPhoneKey = (k) => { const lk = String(k).toLowerCase(); return lk.includes("phone") || lk.includes("phonenumber") || lk.includes("mobile") || lk.includes("cell"); };

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

/* flexible id match (works with s_… ids and “Record ID” values) */
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

/* -------------------- ROUTES -------------------- */

/** public search (name/email/phone/address) – live sheet */
router.get("/search", async (req, res) => {
  const rawQ = String(req.query.q || "").trim();
  if (!rawQ) return res.json([]);
  const type = String(req.query.type || "").toLowerCase();

  const rows = await getDataRows();
  const s = (v) => (v == null ? "" : String(v)).trim().toLowerCase();
  const digits = (v) => String(v || "").replace(/\D/g, "");

  const q = rawQ.toLowerCase();
  const qDigits = digits(rawQ);

  const inName = (r) => s([r.name, r.Name, r.Employee, r.EmployeeName, [r.FirstName, r.MiddleName, r.LastName].filter(Boolean).join(" ")].filter(Boolean).join(" ")).includes(q);
  const inEmail = (r) => collectEmails(r).some(e => e.toLowerCase().includes(q));
  const inPhone = (r) => digits(pickPhone(r)).includes(qDigits);
  const inAddress = (r) => s([r.address, r.Address, r.Address1, r.AddressLine1, r.HomeAddress, [r.City, r.State, r.Zip].filter(Boolean).join(", "), [r.city, r.state, r.zip].filter(Boolean).join(", ")].filter(Boolean).join(" ")).includes(q);

  const map = { name: inName, email: inEmail, phone: inPhone, address: inAddress };
  const pred = map[type] || inName;

  const out = rows.filter(pred).slice(0, 2000).map((r, idx) => ({
    id: String(r.id ?? r.ID ?? idx),
    name: String(r.name || r.Name || "(no name)"),
    email: maskEmail(pickPrimaryEmail(r)),
    phone: maskPhone(pickPhone(r)),
    address: maskAddress(r.address || r.Address1 || ""),
    dob: r.dob || r.DateOfBirth || r.BirthDate || "",
    riskLevel: r.riskLevel || "medium",
  }));

  res.json(out);
});

/** detail – SAME DATA SOURCE as search/admin (sheet) */
router.get("/detail/:id", async (req, res) => {
  const id = String(req.params.id);
  const rows = await getDataRows();
  const row = findRecord(rows, id);
  if (!row) return res.status(404).json({ ok: false, error: "Not found" });

  const payload = {
    ok: true,
    id: String(row.id ?? row.ID ?? ""),
    name: String(row.name || row.Name || "(no name)"),
    email: maskEmail(pickPrimaryEmail(row)),
    emails: collectEmails(row).map(maskEmail),
    phone: maskPhone(pickPhone(row)),
    ssn: maskSSNFirst2Last3(row.ssn || row.SSN || ""),
    address: maskAddress(row.address || row.Address || row.Address1 || ""),
    dobFull: String(row.dob || row.DateOfBirth || row.BirthDate || ""),
    riskLevel: row.riskLevel || "medium",
    recommendations: [
      "Rotate passwords and enable MFA on all important accounts",
      "Place a fraud alert and monitor your credit reports",
      "Do not respond to unsolicited links or attachments",
    ],
    columns: row.columns || {},     // full original headers
    display: row.columns || {},     // frontend can prefer this (already masked above where needed)
  };
  res.json(payload);
});

/** exposure scan – also checks sheet for matches by email/domain */
router.post("/scan", express.json(), async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const domain = String(req.body?.domain || "").trim().toLowerCase();

    if (!email && !domain) return res.status(400).json({ ok: false, error: "Provide email or domain." });

    const rows = await getDataRows();

    const exposures = [];
    const now = new Date().toISOString();

    const emailMatches = (r) => collectEmails(r).some((e) => e.toLowerCase() === email);
    const domainMatches = (r) => {
      const ds = collectEmails(r)
        .map((e) => e.split("@")[1]?.toLowerCase())
        .filter(Boolean);
      return ds.includes(domain);
    };

    for (const r of rows) {
      const hit =
        (email && emailMatches(r)) ||
        (!email && domain && domainMatches(r));

      if (!hit) continue;

      exposures.push({
        id: String(r.id ?? ""),
        type: "pii",
        source: "Sheet",
        firstSeen: r.dateAdded || now,
        lastSeen: now,
        severity: r.riskLevel || "medium",
        snippet: `${r.name || ""} ${r.address || ""}`.trim() || undefined,
      });
      if (exposures.length >= 5000) break;
    }

    const score = Math.min(100, exposures.length ? 30 + Math.min(70, exposures.length) : 0);
    const severity = score >= 60 ? "high" : score >= 30 ? "medium" : "low";

    return res.json({
      ok: true,
      scannedAt: now,
      input: { email, domain },
      exposures,
      summary: {
        score,
        severity,
        actions: [
          "Enable MFA on important accounts",
          "Reset reused/old passwords",
          domain ? `Review accounts on ${domain}` : "Review your main accounts",
        ],
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Scan failed" });
  }
});

export default router;
