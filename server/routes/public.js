// Public API for the "Talk to us" website widget (public/widget.js).
// No login: each chat gets a random secret, and everything is rate-limited.
import crypto from "node:crypto";
import express from "express";
import { handleIncoming } from "../channels.js";
import { endCall, startCall } from "../calls.js";
import { agentLanguages, lang, phrase } from "../languages.js";
import { canTakeCalls } from "../plans.js";
import { rateLimiter, wrap } from "./helpers.js";

export function publicRouter(db) {
  const r = express.Router();
  const sessionLimit = rateLimiter({ limit: 10, windowMs: 60 * 60e3 });
  const messageLimit = rateLimiter({ limit: 40, windowMs: 10 * 60e3 });

  // Any website may embed the widget; requests carry no cookies, only the chat secret.
  r.use((req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    });
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  const findAgent = (publicId) => db.find("agents", (a) => a.publicId === publicId && a.widgetEnabled && a.active)[0];

  r.get("/agents/:publicId", (req, res) => {
    const agent = findAgent(req.params.publicId);
    if (!agent) return res.status(404).json({ error: "This assistant is not available." });
    res.json({
      name: agent.name,
      business: db.get("orgs", agent.orgId)?.name,
      language: agent.language,
      languages: agentLanguages(agent).map((code) => ({ code, native: lang(code).native })),
    });
  });

  r.post("/agents/:publicId/sessions", (req, res) => {
    const agent = findAgent(req.params.publicId);
    if (!agent) return res.status(404).json({ error: "This assistant is not available." });
    if (!sessionLimit(req.ip)) return res.status(429).json({ error: "Too many chats. Please try again later." });
    const org = db.get("orgs", agent.orgId);
    if (!org || !canTakeCalls(db, org)) return res.status(503).json({ error: "The assistant is busy right now. Please call the business directly." });
    const secret = crypto.randomBytes(24).toString("base64url");
    // Phone greetings say "thanks for calling"; a website chat gets its own, in the visitor's language.
    const language = agentLanguages(agent).includes(req.body?.language) ? req.body.language : agent.language;
    const greeting = phrase(language, "chat", { org: org.name });
    const call = startCall(db, agent, { channel: "widget", widgetSecretHash: hash(secret), greeting, language });
    res.status(201).json({ sessionId: call.id, secret, greeting: call.greeting, language: call.language });
  });

  const session = (req, res) => {
    const call = db.get("calls", req.params.id);
    const given = String(req.body?.secret || "");
    if (!call || call.channel !== "widget" || !given || !safeEqual(hash(given), call.widgetSecretHash || "")) {
      res.status(404).json({ error: "Chat not found." });
      return null;
    }
    return call;
  };

  r.post("/sessions/:id/say", wrap(async (req, res) => {
    const call = session(req, res);
    if (!call) return;
    if (call.status === "ended") return res.status(409).json({ error: "This chat has ended." });
    if (!messageLimit(req.ip)) return res.status(429).json({ error: "Slow down a little, please." });
    const text = String(req.body?.text || "").trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: "Say something first." });
    const agent = db.get("agents", call.agentId);
    if (!agent) return res.status(404).json({ error: "This assistant is not available." });
    const { reply, call: updated } = await handleIncoming(db, { agent, channel: "widget", from: call.id, text, call });
    const fresh = db.get("calls", (updated ?? call).id);
    const action = fresh.status === "ended" ? { type: "hangup" } : null;
    res.json({ reply, language: fresh.language, human: Boolean(fresh.humanMode), count: fresh.transcript.length, ended: Boolean(action), transfer: action?.type === "transfer" ? agent.transferNumber || "" : undefined });
  }));

  // The website chat polls this while a person from the team is replying.
  r.post("/sessions/:id/messages", (req, res) => {
    const call = session(req, res);
    if (!call) return;
    const after = Math.max(0, Number(req.body?.after) || 0);
    res.json({
      human: Boolean(call.humanMode),
      count: call.transcript.length,
      messages: call.transcript.slice(after).filter((t) => t.role !== "caller").map((t) => ({ role: t.role === "human" ? "human" : "agent", text: t.text, by: t.role === "human" ? t.by || "Team" : null })),
    });
  });

  r.post("/sessions/:id/end", (req, res) => {
    const call = session(req, res);
    if (!call) return;
    endCall(db, call, "completed");
    res.json({ ok: true });
  });

  return r;
}

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
