// =========================================================
// server.js — LinkedIn Network Assistant backend (Google Gemini)
// =========================================================
// This server is the ONLY place that knows your Gemini API key.
// The extension never sees the key. The server also enforces the
// paywall/quota (free limit vs. Pro).
//
// Run locally:  npm install  &&  npm start
// Deploy:       Render / Railway / Fly.io. Set GEMINI_API_KEY as a
//               secret/environment variable — never in the code.
// =========================================================

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";

const app = express();
app.set("trust proxy", 1); // required behind most hosting proxies (Render/Railway)
app.use(express.json({ limit: "32kb" }));

// Only YOUR extension may call this API (the Chrome extension id shown on
// chrome://extensions after loading the extension unpacked).
const ALLOWED_ORIGIN = "chrome-extension://pagdckjkcipllcfhocefdcaodlhdfbjj";

app.use(
  cors({
    origin: (origin, callback) => {
      // Extension requests may omit the Origin header; allow those too.
      if (!origin || origin === ALLOWED_ORIGIN) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    }
  })
);

// Basic abuse protection: max 30 requests per minute per IP.
app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // set as an environment variable
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const PORT = process.env.PORT || 8787;

const COMMENT_COUNT = 3; // the extension expects exactly 3 comments
const FREE_DAILY_LIMIT = 3; // free comments per installation per day
const PRO_DAILY_LIMIT = 100; // safety cap so a Pro account cannot be abused

// NOTE: this in-memory store resets when the server restarts and does not
// work across multiple instances. For production, use Redis or a database.
const usage = new Map(); // deviceId -> { day, count }

// Gemini client. Created lazily so the server can still boot without a key
// and return a clear error instead of crashing.
let geminiModel = null;
function getGeminiModel() {
  if (!geminiModel && GEMINI_API_KEY) {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  }
  return geminiModel;
}

function isWithinQuota(deviceId, paid) {
  const today = new Date().toISOString().slice(0, 10);
  const limit = paid ? PRO_DAILY_LIMIT : FREE_DAILY_LIMIT;
  const entry = usage.get(deviceId);
  if (!entry || entry.day !== today) {
    usage.set(deviceId, { day: today, count: 1 });
    return true;
  }
  if (entry.count >= limit) {
    return false;
  }
  entry.count += 1;
  return true;
}

function buildPrompt(postText, count) {
  return (
    "You are a professional LinkedIn advisor with 10 years of experience " +
    "in B2B networking and personal branding.\n\n" +
    `Read the following LinkedIn post:\n"""\n${postText}\n"""\n\n` +
    `Write ${count} different, short and smart comments (2-3 sentences each). ` +
    "They must sound human, be relevant to the post, and invite a conversation. " +
    "Mix an appreciative, a curious and an experience-based angle.\n\n" +
    `Return ONLY the ${count} comments — one per line, no numbering, no ` +
    "explanations. Write them in English."
  );
}

function parseComments(rawText, count) {
  if (!rawText) {
    return [];
  }
  return String(rawText)
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s*/, "")) // strips "- ", "1. " etc.
    .filter((line) => line.length > 0)
    .slice(0, count);
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/generate", async (req, res) => {
  const { postText, deviceId, paid } = req.body || {};

  if (typeof postText !== "string" || postText.trim().length === 0) {
    return res.status(400).json({ error: "postText is required" });
  }
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    return res.status(400).json({ error: "deviceId is required" });
  }
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "Server is missing GEMINI_API_KEY" });
  }

  // IMPORTANT: "paid" comes from the client (ExtensionPay stores its
  // paid status locally), so it can be spoofed. For strict, tamper-proof
  // enforcement you need your own Stripe integration + a server-side
  // database that Stripe webhooks keep up to date (see README).
  const isPaid = paid === true;

  if (!isWithinQuota(deviceId, isPaid)) {
    return res.status(402).json({ error: "Free limit reached" }); // 402 = Payment Required
  }

  try {
    const model = getGeminiModel();
    const result = await model.generateContent(buildPrompt(postText, COMMENT_COUNT));
    const raw = result.response.text();

    // Same response shape the extension already expects: { comments: [...] }
    return res.json({ comments: parseComments(raw, COMMENT_COUNT) });
  } catch (error) {
    console.error("Gemini error:", error && error.message ? error.message : error);
    return res.status(502).json({ error: "AI provider error" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT} (model: ${GEMINI_MODEL})`);
});
