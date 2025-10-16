// server/inbox.routes.js
import express from "express";
import { requireAuth } from "./middleware/auth.js";
import {
  listThreads, getThread, upsertIncoming, addAdminReply, setThreadStatus
} from "./inbox.store.js";

const router = express.Router();

/** Public: Contact form → create/append a thread */
router.post("/contact", async (req, res) => {
  const { name, email, subject = "", message, website } = req.body || {};
  if (website) return res.json({ ok: true }); // honeypot
  if (!name || !email || !message) return res.status(400).json({ ok: false, error: "Missing fields" });
  const { thread } = upsertIncoming({ name, email, subject, body: message });
  res.json({ ok: true, threadId: thread.id });
});

/** Admin: list inbox threads */
router.get("/admin/inbox", requireAuth, (req, res) => {
  if (String(req.user?.role).toLowerCase() !== "admin") return res.status(403).json({ ok: false });
  res.json({ ok: true, threads: listThreads() });
});

/** Admin: single thread */
router.get("/admin/inbox/:id", requireAuth, (req, res) => {
  if (String(req.user?.role).toLowerCase() !== "admin") return res.status(403).json({ ok: false });
  const t = getThread(req.params.id);
  if (!t) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, thread: { ...t, messages: undefined }, messages: t.messages });
});

/** Admin: reply */
router.post("/admin/inbox/:id/reply", requireAuth, (req, res) => {
  if (String(req.user?.role).toLowerCase() !== "admin") return res.status(403).json({ ok: false });
  const { body } = req.body || {};
  if (!body) return res.status(400).json({ ok: false, error: "Missing body" });
  const t = addAdminReply(req.params.id, body);
  if (!t) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true });
});

/** Admin: set status */
router.post("/admin/inbox/:id/status", requireAuth, (req, res) => {
  if (String(req.user?.role).toLowerCase() !== "admin") return res.status(403).json({ ok: false });
  const { status } = req.body || {};
  if (!["open", "read", "closed"].includes(status)) return res.status(400).json({ ok: false, error: "Bad status" });
  const t = setThreadStatus(req.params.id, status);
  if (!t) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true });
});

export default router;
