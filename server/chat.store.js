// server/chat.store.js
import { randomUUID } from 'crypto';

const threads = new Map(); // threadId -> { id, user:{name,email}, createdAt, messages:[], unreadAdminCount }
const sockets = { admin: new Set(), user: new Map() }; // user sockets keyed by threadId

export function createThread({ name, email }) {
  const id = randomUUID();
  const t = { id, user: { name, email }, createdAt: new Date().toISOString(), messages: [], unreadAdminCount: 0 };
  threads.set(id, t);
  return t;
}

export function getThread(threadId) {
  return threads.get(threadId) || null;
}

export function listThreads() {
  // sort by last message time desc
  return Array.from(threads.values()).sort((a, b) => {
    const at = a.messages.at(-1)?.createdAt || a.createdAt;
    const bt = b.messages.at(-1)?.createdAt || b.createdAt;
    return new Date(bt) - new Date(at);
  });
}

export function addMessage({ threadId, direction, text }) {
  const t = threads.get(threadId);
  if (!t) return null;
  const msg = {
    id: randomUUID(),
    threadId,
    direction, // 'inbound' (user->admin) | 'outbound' (admin->user)
    message: text,
    createdAt: new Date().toISOString(),
    read: direction === 'outbound' ? true : false,
  };
  t.messages.push(msg);
  if (direction === 'inbound') t.unreadAdminCount = (t.unreadAdminCount || 0) + 1;
  return msg;
}

export function listMessages(threadId) {
  const t = threads.get(threadId);
  return t ? t.messages : [];
}

export function markAdminRead(threadId) {
  const t = threads.get(threadId);
  if (!t) return;
  t.unreadAdminCount = 0;
  t.messages = t.messages.map(m => m.direction === 'inbound' ? { ...m, read: true } : m);
}

export function registerAdminSocket(ws) {
  sockets.admin.add(ws);
  ws.on('close', () => sockets.admin.delete(ws));
}

export function registerUserSocket(threadId, ws) {
  if (!sockets.user.has(threadId)) sockets.user.set(threadId, new Set());
  const set = sockets.user.get(threadId);
  set.add(ws);
  ws.on('close', () => {
    set.delete(ws);
    if (set.size === 0) sockets.user.delete(threadId);
  });
}

export function notifyAdmins(payload) {
  for (const ws of sockets.admin) {
    try { ws.send(JSON.stringify(payload)); } catch {}
  }
}

export function notifyUser(threadId, payload) {
  const set = sockets.user.get(threadId);
  if (!set) return;
  for (const ws of set) {
    try { ws.send(JSON.stringify(payload)); } catch {}
  }
}
