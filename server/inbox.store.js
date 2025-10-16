// server/inbox.store.js  (ESM)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "inbox.json");

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ threads: {}, order: [] }, null, 2));
}
function read() { ensureFile(); return JSON.parse(fs.readFileSync(FILE, "utf8") || "{}"); }
function write(db) { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); }

function nowISO() { return new Date().toISOString(); }
function id() { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
function threadKey(email, subject = "") { return (email || "").trim().toLowerCase() + "::" + subject.trim().toLowerCase(); }

export function listThreads() {
  const db = read();
  return db.order.map(k => db.threads[k]);
}

export function getThread(threadId) {
  const db = read();
  const t = db.threads[threadId];
  return t ? { ...t, messages: t.messages || [] } : null;
}

export function upsertIncoming({ name, email, subject = "", body }) {
  const db = read();
  const key = threadKey(email, subject);
  let t = db.threads[key];
  const at = nowISO();

  if (!t) {
    t = db.threads[key] = {
      id: key,
      fromName: name, fromEmail: email, subject,
      status: "open",
      lastMessageAt: at,
      messages: []
    };
    // newest first
    db.order = [key, ...db.order.filter(x => x !== key)];
  } else {
    t.lastMessageAt = at;
    if (subject && !t.subject) t.subject = subject;
    // move to top
    db.order = [key, ...db.order.filter(x => x !== key)];
  }

  t.messages.push({
    id: id(),
    direction: "in",
    createdAt: at,
    fromName: name, fromEmail: email,
    body
  });

  write(db);
  return { thread: t, messageId: t.messages[t.messages.length - 1].id };
}

export function addAdminReply(threadId, body) {
  const db = read();
  const t = db.threads[threadId];
  if (!t) return null;
  const at = nowISO();
  t.messages.push({
    id: id(),
    direction: "out",
    createdAt: at,
    fromName: "Admin", fromEmail: "admin@local",
    body
  });
  t.lastMessageAt = at;
  write(db);
  return t;
}

export function setThreadStatus(threadId, status) {
  const db = read();
  const t = db.threads[threadId];
  if (!t) return null;
  t.status = status;
  write(db);
  return t;
}
