// ESM
import express from "express";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "./middleware/auth.js";

const router = express.Router();

// fixed admin creds
const ADMIN_EMAIL = "Admin@secdata.login";
const ADMIN_PASSWORD = "Jabari@2025#";

router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });

  const okEmail = String(email).toLowerCase() === ADMIN_EMAIL.toLowerCase();
  const okPass = String(password) === ADMIN_PASSWORD;
  if (!okEmail || !okPass) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ id: "admin-1", email: ADMIN_EMAIL, role: "admin" }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { email: ADMIN_EMAIL, role: "admin" } });
});

export default router;
