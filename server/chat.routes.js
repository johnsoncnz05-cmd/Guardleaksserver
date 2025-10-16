// server/chat.routes.js
import { Router } from 'express';
import {
  createThread, getThread, addMessage, listThreads, listMessages, markAdminRead,
  notifyAdmins, notifyUser
} from './chat.store.js';
import { requireAuth } from './middleware/auth.js';

const router = Router();

/* ---------- Public (user) ---------- */

// init or fetch a thread by threadId (anonymous)
router.post('/init', (req, res) => {
  const { threadId, name, email } = req.body || {};
  if (threadId) {
    const t = getThread(String(threadId));
    if (!t) return res.status(404).json({ ok:false, error:'thread not found' });
    return res.json({ ok:true, thread: t });
  }
  const t = createThread({ name: String(name||'Guest'), email: String(email||'') });
  return res.json({ ok:true, thread: t });
});

router.post('/send', (req, res) => {
  const { threadId, message } = req.body || {};
  if (!threadId || !message) return res.status(400).json({ ok:false, error:'threadId and message required' });
  const t = getThread(String(threadId));
  if (!t) return res.status(404).json({ ok:false, error:'thread not found' });

  const msg = addMessage({ threadId: t.id, direction: 'inbound', text: String(message) });
  // push to admin listeners
  notifyAdmins({ type:'chat:new', threadId: t.id, message: msg, threadSummary: { id: t.id, user: t.user, unreadAdminCount: t.unreadAdminCount } });
  return res.json({ ok:true, message: msg });
});

/* ---------- Admin ---------- */

router.get('/admin/threads', requireAuth, (req, res) => {
  // expect req.user.role === 'admin' (requireAuth handles)
  res.json(listThreads());
});

router.get('/admin/messages', requireAuth, (req, res) => {
  const threadId = String(req.query.threadId || '');
  if (!threadId) return res.status(400).json({ ok:false, error:'threadId required' });
  res.json(listMessages(threadId));
});

router.post('/admin/reply', requireAuth, (req, res) => {
  const { threadId, message } = req.body || {};
  if (!threadId || !message) return res.status(400).json({ ok:false, error:'threadId and message required' });
  const t = getThread(String(threadId));
  if (!t) return res.status(404).json({ ok:false, error:'thread not found' });

  const msg = addMessage({ threadId: t.id, direction: 'outbound', text: String(message) });
  // notify user sockets
  notifyUser(t.id, { type:'chat:reply', threadId: t.id, message: msg });
  return res.json(msg);
});

router.post('/admin/mark-read', requireAuth, (req, res) => {
  const { threadId } = req.body || {};
  if (!threadId) return res.status(400).json({ ok:false, error:'threadId required' });
  markAdminRead(String(threadId));
  return res.json({ ok:true });
});

export default router;
