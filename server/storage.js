// server/storage.js
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Always resolve relative to THIS file (server/)
const DATA_DIR     = path.resolve(__dirname, 'data');
const BREACH_FILE  = path.join(DATA_DIR, 'breach.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');

async function ensureFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const f of [BREACH_FILE, REVIEWS_FILE]) {
    try { await fs.access(f); }
    catch { await fs.writeFile(f, '[]', 'utf8'); }
  }
}

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const txt = raw.trim();
    if (!txt) return [];
    return JSON.parse(txt);
  } catch {
    // Recover from bad/missing JSON
    return [];
  }
}

export async function getBreachData() {
  await ensureFiles();
  return readJson(BREACH_FILE);
}

export async function getReviews() {
  await ensureFiles();
  return readJson(REVIEWS_FILE);
}

export async function appendReview(review) {
  await ensureFiles();
  const all = await readJson(REVIEWS_FILE);
  all.push(review);
  await fs.writeFile(REVIEWS_FILE, JSON.stringify(all, null, 2), 'utf8');
  return { ok: true };
}
