// server/breach.routes.js (ESM) — FINAL PATCH (additive, safe)
import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const router = express.Router();

// ----- storage paths -----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "./data");
const BREACH_FILE = path.join(DATA_DIR, "breaches.json");

// -------- helpers --------
async function ensureJson(file, initial) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.access(file);
  } catch {
    await fs.writeFile(file, JSON.stringify(initial, null, 2), "utf8");
  }
}
await ensureJson(BREACH_FILE, []);

async function readJson(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
async function writeJson(file, rows) {
  await fs.writeFile(file, JSON.stringify(rows, null, 2), "utf8");
}

// ---- value pickers / normalizers ----
function normalizeName(row) {
  if (row.name) return String(row.name);
  const fn = row.firstName || row.FirstName || row.FIRSTNAME;
  const mn = row.middleName || row.MiddleName || row.MIDDLENAME;
  const ln = row.lastName || row.LastName || row.LASTNAME;
  const suffix = row.suffix || row.Suffix || row.SUFFIX;
  const parts = [fn, mn, ln, suffix].filter(Boolean);
  return parts.length ? parts.join(" ").replace(/\s+/g, " ").trim() : "(no name)";
}
function collectEmails(row) {
  const seen = new Set();
  const visit = (obj) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (!v) continue;
      if (String(k).toLowerCase().includes("email")) {
        const s = String(v).trim();
        if (s) seen.add(s);
      }
    }
  };
  visit(row);
  visit(row.columns); // include preserved original columns
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
  // Look into columns: PHONE NUMBER 1/2/3 etc.
  for (const [k, v] of Object.entries(row.columns || {})) {
    const lk = String(k).toLowerCase();
    if ((lk.includes("phone") || lk.includes("phonenumber") || lk.includes("mobile") || lk.includes("cell")) && v) {
      return v;
    }
  }
  return "";
}
function pickAddress(row) {
  return row.address || row.Address1 || row.Address || row.HomeAddress || (row.columns?.Address) || "";
}
function pickDOB(row) {
  return row.BirthDate || row.DateOfBirth || row.dob || row.DOB || row.birthdate || row.BirthDate || "";
}
function pickSSN(row) {
  return row.ssn || row.SSN || row.columns?.SSN || "";
}

// ---- masking / formatting ----
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

// yyyy-mm-dd or date-ish -> mmddyyyy (digits only)
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

// ---- sources / risk ----
function inferSources(raw) {
  const srcs = raw.sources;
  if (Array.isArray(srcs)) {
    return srcs.map((s, i) => ({
      name: String(s?.name || s || `Source ${i + 1}`),
      url: String(s?.url || ""),
      dateFound: raw.dateAdded || raw.DateAdded || new Date().toISOString(),
      credibility: ["high", "medium", "low"].includes(String(s?.credibility)) ? s.credibility : "medium",
    }));
  }
  const txt = JSON.stringify(raw).toLowerCase();
  const found = [];
  const add = (name) =>
    found.push({
      name,
      url: "",
      dateFound: raw.dateAdded || raw.DateAdded || new Date().toISOString(),
      credibility: "medium",
    });
  if (txt.includes("telegram")) add("Telegram");
  if (txt.includes("pastebin")) add("Pastebin");
  if (txt.includes("breachforum")) add("Breach Forums");
  if (txt.includes("raidforums")) add("Raid Forums");
  if (!found.length) add("Unknown source");
  return found;
}

function inferRisk(row) {
  const hasSSN = !!pickSSN(row);
  const hasDOB = !!pickDOB(row);
  const hasPhone = !!pickPhone(row);
  const hasEmail = collectEmails(row).length > 0;
  if (hasSSN || (hasDOB && hasEmail && hasPhone)) return "high";
  if ((hasEmail && hasPhone) || hasDOB) return "medium";
  return "low";
}

function potentialMisuse(row) {
  const risks = [];
  if (collectEmails(row).length) risks.push("Phishing & account takeover attempts via email");
  if (pickPhone(row)) risks.push("Smishing & SIM-swap targeting your phone number");
  if (pickAddress(row)) risks.push("Targeted scams using partial home/work address");
  if (pickDOB(row)) risks.push("Identity verification bypass using date of birth");
  if (pickSSN(row)) risks.push("Full identity theft & fraudulent credit applications");
  return risks.length ? risks : ["General privacy risk from exposed PII"];
}

// Key classifiers for masking by header label
const isEmailKey = (k) => String(k).toLowerCase().includes("email");
const isPhoneKey = (k) => {
  const lk = String(k).toLowerCase();
  return lk.includes("phone") || lk.includes("phonenumber") || lk.includes("mobile") || lk.includes("cell");
};
const isSSNKey = (k) => {
  const lk = String(k).toLowerCase();
  return lk === "ssn" || lk.includes("social");
};
const isDOBKey = (k) => {
  const lk = String(k).toLowerCase();
  return lk.includes("birthdate") || lk.includes("dateofbirth") || lk === "dob" || lk.includes("birth");
};
const isAddressKey = (k) => String(k).toLowerCase().includes("address");
const isDLKey = (k) => {
  const lk = String(k).toLowerCase();
  return lk === "dl" || (lk.includes("driver") && lk.includes("license"));
};
const isGenericIDKey = (k) => String(k).toLowerCase() === "id";

// Build masked display map of ALL fields (top-level + preserved columns)
function buildDisplay(row) {
  const out = {};
  const put = (k, v) => {
    if (v == null || v === "") return;
    if (isEmailKey(k)) out[k] = maskEmail(v);
    else if (isPhoneKey(k)) out[k] = maskPhone(v);
    else if (isSSNKey(k)) out[k] = maskSSNFirst2Last3(v);
    else if (isDOBKey(k)) out[k] = toMMDDYYYYDigits(v);
    else if (isAddressKey(k)) out[k] = maskAddress(v);
    else if (isDLKey(k)) {
      const s = String(v || "");
      const d = s.replace(/\W+/g, "");
      const tail = d.slice(-3);
      out[k] = `${"*".repeat(Math.max(3, d.length - 3))}${tail}`;
    }
    else if (isGenericIDKey(k) && k !== "id") {
      const s = String(v || "");
      const d = s.replace(/\W+/g, "");
      const tail = d.slice(-3);
      out[k] = `${"*".repeat(Math.max(3, d.length - 3))}${tail}`;
    }
    else out[k] = v;
  };

  // canonical top-level
  for (const [k,v] of Object.entries(row)) if (k !== "columns") put(k, v);
  // original sheet columns
  for (const [k,v] of Object.entries(row.columns || {})) if (out[k] == null) put(k, v);

  // aggregated emails
  const emails = [];
  const visit = (obj) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (isEmailKey(k) && v) emails.push(String(v));
    }
  };
  visit(row);
  visit(row.columns);
  if (emails.length) out.emails = Array.from(new Set(emails)).map(maskEmail);

  return out;
}

// ---------- routes ----------

// search – used by the public Check page (admin surface)
router.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
  const rows = await readJson(BREACH_FILE);
  if (!q) return res.json([]);

  const results = [];
  for (const row of rows) {
    const hay = JSON.stringify(row).toLowerCase();
    if (hay.includes(q)) {
      const primaryEmail = pickPrimaryEmail(row);
      results.push({
        id: String(row.id ?? row.ID ?? results.length),
        name: normalizeName(row),
        email: maskEmail(primaryEmail),
        phone: maskPhone(pickPhone(row)),
        address: maskAddress(pickAddress(row)),
        dob: toMMDDYYYYDigits(pickDOB(row)),
        riskLevel: row.riskLevel || inferRisk(row),
      });
      if (results.length >= limit) break;
    }
  }
  res.json(results);
});

// detail – full normalized view with masked sensitive data + ALL columns
router.get("/detail/:id", async (req, res) => {
  const id = String(req.params.id);
  const rows = await readJson(BREACH_FILE);

  let row = rows.find((r) => String(r.id ?? r.ID ?? "").toLowerCase() === id.toLowerCase());
  if (!row) {
    // also match by any field equal to id (supports "Record ID" links)
    const needle = id.toLowerCase();
    row = rows.find((r) => {
      for (const [k,v] of Object.entries(r)) {
        if (k === "columns") continue;
        if (String(v).toLowerCase() === needle) return true;
      }
      for (const [k,v] of Object.entries(r.columns || {})) {
        if (String(v).toLowerCase() === needle) return true;
      }
      return false;
    });
  }
  if (!row) {
    const idx = Number(id);
    if (!Number.isNaN(idx) && idx >= 0 && idx < rows.length) row = rows[idx];
  }
  if (!row) return res.status(404).json({ ok: false, error: "Not found" });

  const sources = inferSources(row);
  const risk = row.riskLevel || inferRisk(row);

  const allEmails = collectEmails(row);
  const primaryEmail = pickPrimaryEmail(row);

  const payload = {
    id: String(row.id ?? row.ID ?? ""),
    name: normalizeName(row),

    email: maskEmail(primaryEmail),
    emails: allEmails.map(maskEmail),

    phone: maskPhone(pickPhone(row)),
    ssn: maskSSNFirst2Last3(pickSSN(row)),
    address: maskAddress(pickAddress(row)),

    // IMPORTANT: mmddyyyy (digits only)
    dobFull: toMMDDYYYYDigits(pickDOB(row)),

    sources,
    riskLevel: risk,
    recommendations: [
      "Rotate passwords and enable MFA on all important accounts",
      "Place a fraud alert and monitor your credit reports",
      "Do not respond to unsolicited links or attachments",
    ],
    potentialMisuse: potentialMisuse(row),
    dateAdded: row.dateAdded || row.DateAdded || null,
    contactLink: `/contact?topic=removal&ref=${encodeURIComponent(String(row.id ?? ""))}`,

    // provide everything for the frontend
    columns: row.columns || {},
    display: buildDisplay(row),
  };

  res.json(payload);
});

// admin delete – remove one row by id
router.delete("/:id", async (req, res) => {
  const id = String(req.params.id);
  const rows = await readJson(BREACH_FILE);
  const next = rows.filter((r) => String(r.id ?? r.ID ?? "") !== id);
  const deleted = rows.length - next.length;
  if (deleted > 0) await writeJson(BREACH_FILE, next);
  res.json({ ok: true, deleted });
});

export default router;

