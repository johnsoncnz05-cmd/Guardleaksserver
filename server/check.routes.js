import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "./data");
const BREACH_FILE = path.join(DATA_DIR, "breaches.json");

async function readJsonSafe(file) {
  try {
    const t = await fs.readFile(file, "utf8");
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// ---------- value helpers ----------
const nonEmpty = (v) => v != null && String(v).trim() !== "";

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

// ---------- masking / formatting ----------
const maskEmail = (e) => {
  if (!e) return "";
  const s = String(e);
  if (!s.includes("@")) return s;
  const [user, domain] = s.split("@");
  if (!user || !domain) return s;
  const keepTail = Math.min(3, user.length > 1 ? user.length - 1 : 0);
  const head = user.slice(0, 1);
  const tail = keepTail ? user.slice(-keepTail) : "";
  const midLen = Math.max(1, user.length - (1 + keepTail));
  const mid = "•".repeat(midLen);
  return `${head}${mid}${tail}@${domain}`;
};

const maskPhone = (p) => {
  if (!p) return "";
  const digits = String(p).replace(/\D/g, "");
  if (!digits) return String(p);
  const hasCC = digits.length > 10;
  const cc = hasCC ? `+${digits.slice(0, digits.length - 10)} ` : "";
  const last10 = hasCC ? digits.slice(-10) : digits.padStart(10, "0").slice(-10);
  const area = last10.slice(0, 3);
  const last3 = last10.slice(-3);
  const midLen = Math.max(0, last10.length - 6);
  const midMasked = "*".repeat(midLen || 1);
  return `${cc}(${area}) ${midMasked}${last3}`;
};

const maskSSNFirst2Last3 = (s) => {
  const digits = String(s || "").replace(/\D/g, "");
  if (digits.length < 5) {
    const last3 = digits.slice(-3);
    return `***-**-${last3.padStart(3, "*")}`;
  }
  const first2 = digits.slice(0, 2);
  const last3 = digits.slice(-3);
  return `${first2}*-**-***${last3}`;
};

const maskAddress = (a) => (a ? String(a).replace(/^\d+/, "***") : "");

/** Search/list DOB: keep masked year/month only */
const maskDOB = (d) =>
  d && /^\d{4}-\d{2}-\d{2}/.test(String(d))
    ? String(d).replace(/^\d{4}-\d{2}/, "****-**")
    : String(d || "").replace(/\d/g, "*");

/** Detail DOB: return mmddyyyy digits only */
function formatDOBFull(v) {
  if (!v) return "";
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${mm}${dd}${yyyy}`; // mmddyyyy
  }
  const m = String(v).match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (m) return `${m[2]}${m[3]}${m[1]}`;
  return String(v);
}

// ---------- sources / risk ----------
function normalizeSources(sources) {
  if (Array.isArray(sources)) {
    return sources.map((s, i) => ({
      name: s?.name ?? String(s ?? `Source ${i + 1}`),
      url: s?.url ?? "",
      dateFound: s?.dateFound ?? new Date().toISOString(),
      credibility: ["high", "medium", "low"].includes(s?.credibility)
        ? s.credibility
        : "medium",
    }));
  }
  if (typeof sources === "string" && sources.trim()) {
    return String(sources)
      .split(/\s*[|,]\s*/).filter(Boolean)
      .map((name) => ({ name, url: "", dateFound: new Date().toISOString(), credibility: "medium" }));
  }
  return [];
}

function computeRisk(r) {
  const risk =
    r?.riskLevel ||
    (String(r.EmployeeStatus || "").toLowerCase().includes("terminated") ? "high" : undefined) ||
    (listEmail(r) || listPhone(r) ? "medium" : undefined) ||
    "medium";
  return ["low", "medium", "high"].includes(risk) ? risk : "medium";
}

function matchRow(row, q, f) {
  const hay = Object.values(row).join(" ").toLowerCase();
  const qOk = q ? hay.includes(q) : true;
  const nameOk = f.name ? listName(row).toLowerCase().includes(f.name) : true;
  const dobField = row.DateOfBirth || row.dob || row.birthdate || row.BirthDate || "";
  const dobOk = f.dob ? String(dobField).startsWith(f.dob) : true;
  const emailOk = f.email ? listEmail(row).toLowerCase().includes(f.email) : true;
  const phoneOk = f.phone ? listPhone(row).toLowerCase().includes(f.phone) : true;
  return qOk && nameOk && dobOk && emailOk && phoneOk;
}

// ---------- NEW: /api/scan ----------
router.post("/scan", express.json(), async (req, res) => {
  try {
    const { email, domain } = req.body || {};
    if (!email && !domain) {
      return res.status(400).json({ ok: false, error: "Enter an email or a domain." });
    }

    const rows = await readJsonSafe(BREACH_FILE);
    const lcEmail = String(email || "").toLowerCase();
    const lcDomain = String(domain || "").toLowerCase();

    const domainFromEmail = lcEmail.includes("@") ? lcEmail.split("@")[1] : "";
    const targetDomain = lcDomain || domainFromEmail;

    // find rows with matching email or matching email-domain
    const hits = [];
    for (const r of rows) {
      const name = listName(r);
      const emails = [listEmail(r)].filter(Boolean).map(String);
      const phones = [listPhone(r)].filter(Boolean).map(String);

      const hasEmailMatch = lcEmail && emails.some((e) => String(e).toLowerCase() === lcEmail);
      const hasDomainMatch =
        targetDomain &&
        emails.some((e) => {
          const parts = String(e).toLowerCase().split("@");
          return parts[1] === targetDomain;
        });

      if (hasEmailMatch || hasDomainMatch) {
        hits.push({
          row: r,
          reason: hasEmailMatch ? "email" : "domain",
          name,
          email: emails[0] || "",
          phone: phones[0] || "",
        });
      }
    }

    const exposures = hits.map((h, idx) => {
      const risk = computeRisk(h.row);
      const sev = risk; // "low" | "medium" | "high"
      const srcs = normalizeSources(h.row.sources);
      const source = srcs[0]?.name || "admin-db";
      const seen = h.row.dateAdded || h.row.DateAdded || new Date().toISOString();
      return {
        id: String(h.row.id ?? h.row.ID ?? idx),
        type: h.reason === "email" ? "credential" : "domain-correlation",
        source,
        firstSeen: seen,
        lastSeen: seen,
        severity: sev,
        snippet: [maskEmail(h.email), maskPhone(h.phone)].filter(Boolean).join(" · "),
      };
    });

    // Summary
    const score =
      exposures.reduce((acc, e) => acc + (e.severity === "high" ? 30 : e.severity === "medium" ? 15 : 5), 0) +
      (exposures.length ? 10 : 0);
    const severity = score >= 60 ? "high" : score >= 30 ? "medium" : "low";
    const actions = [
      "Enable MFA on important accounts",
      "Reset reused/old passwords",
      ...(targetDomain ? [`Review accounts on ${targetDomain}`] : []),
    ];

    return res.json({
      ok: true,
      scannedAt: new Date().toISOString(),
      input: { email, domain },
      exposures,
      summary: { score, severity, actions },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Scan failed" });
  }
});

// ---------- /api/check/search ----------
router.get("/search", async (req, res) => {
  try {
    const rows = await readJsonSafe(BREACH_FILE);
    const q = String(req.query.q || "").toLowerCase().trim();
    const filters = {
      name: String(req.query.name || "").toLowerCase().trim(),
      dob: String(req.query.dob || "").trim(),
      email: String(req.query.email || "").toLowerCase().trim(),
      phone: String(req.query.phone || "").toLowerCase().trim(),
    };

    const filtered = rows.filter((r) => matchRow(r, q, filters)).slice(0, 200);

    const out = filtered.map((r, idx) => ({
      id: String(r.id ?? r.ID ?? idx),
      name: listName(r),
      email: maskEmail(listEmail(r)),
      phone: maskPhone(listPhone(r)),
      address: maskAddress(r.address || r.Address1 || r.Address || ""),
      dob: maskDOB(r.DateOfBirth || r.dob || r.birthdate || r.BirthDate || ""),
      riskLevel: computeRisk(r),
      sourcesCount: normalizeSources(r.sources).length,
    }));

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(out);
  } catch {
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json([]); // always JSON
  }
});

// ---------- /api/check/detail/:id ----------
router.get("/detail/:id", async (req, res) => {
  try {
    const id = String(req.params.id);
    const rows = await readJsonSafe(BREACH_FILE);

    let row = rows.find(
      (r) => String(r.id ?? r.ID ?? "").toLowerCase() === id.toLowerCase()
    );
    if (!row) {
      const idx = Number(id);
      if (!Number.isNaN(idx) && idx >= 0 && idx < rows.length) row = rows[idx];
    }
    if (!row) {
      res.setHeader("Content-Type", "application/json");
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    const detail = {
      id: String(row.id ?? row.ID ?? ""),
      name: listName(row),

      email: maskEmail(listEmail(row)),
      phone: maskPhone(listPhone(row)),
      ssn: maskSSNFirst2Last3(row.SSN || row.ssn || ""),

      address: maskAddress(row.Address1 || row.Address || row.address || ""),
      // mmddyyyy
      dob: formatDOBFull(row.DateOfBirth || row.dob || row.birthdate || row.BirthDate || ""),

      sources: normalizeSources(row.sources),
      riskLevel: computeRisk(row),
      recommendations: [
        "Rotate passwords and enable MFA on all accounts.",
        "Monitor credit reports and bank statements for 90 days.",
        "Place a credit freeze if any suspicious activity is detected.",
      ],
    };

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(detail);
  } catch {
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({ ok: false, error: "Unavailable" });
  }
});

export default router;
