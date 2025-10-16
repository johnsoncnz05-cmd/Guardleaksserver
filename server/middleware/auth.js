// ESM
import jwt from "jsonwebtoken";

export const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_TO_A_LONG_RANDOM_SECRET";

export function requireAuth(req, res, next) {
  const hdr = req.get("Authorization") || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
  if (String(req.user.role).toLowerCase() !== "admin") {
    return res.status(403).json({ error: "Admins only" });
  }
  next();
}
