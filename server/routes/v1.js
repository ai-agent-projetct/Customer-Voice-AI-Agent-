// Public REST API (v1) for the business's own systems. Authenticate with
//   Authorization: Bearer vd_live_...
// (create keys in the dashboard under Developers).
//
//   GET  /api/v1/calls            recent calls with summaries and analysis
//   GET  /api/v1/calls/:id        one call with transcript
//   POST /api/v1/calls            have a receptionist phone someone
//   POST /api/v1/leads            add a lead; with call_now the AI phones them in seconds ("speed to lead")
//   GET  /api/v1/leads            leads
//   GET  /api/v1/appointments     bookings
import express from "express";
import { agentLanguages } from "../languages.js";
import { placeDueCalls, queueAiCall } from "../outbound.js";
import { emitEvent } from "../webhooks.js";
import { normalizePhone } from "../util.js";
import { hashKey } from "./developer.js";
import { rateLimiter, wrap } from "./helpers.js";

export function v1Router(db) {
  const r = express.Router();
  const limit = rateLimiter({ limit: 120, windowMs: 60e3 });

  r.use((req, res, next) => {
    const key = (req.get("authorization") || "").replace(/^Bearer /, "");
    const row = key.startsWith("vd_live_") && db.find("apiKeys", (k) => k.hash === hashKey(key))[0];
    if (!row) return res.status(401).json({ error: "Invalid API key." });
    if (!limit(row.id)) return res.status(429).json({ error: "Rate limit: 120 requests per minute." });
    req.org = db.get("orgs", row.orgId);
    if (!req.org) return res.status(401).json({ error: "Invalid API key." });
    db.update("apiKeys", row.id, { lastUsedAt: new Date().toISOString() });
    next();
  });

  const publicCall = ({ messages, system, widgetSecretHash, relayToken, verifiedRefs, demo, ...c }, withTranscript) => {
    const { transcript, ...rest } = c;
    return withTranscript ? c : { ...rest, turns: transcript?.length ?? 0 };
  };
  const mine = (table, req) => db.find(table, (x) => x.orgId === req.org.id && x.source !== "simulation" && x.channel !== "simulation");
  const page = (rows, req) => rows.reverse().slice(0, Math.min(100, Math.max(1, Number(req.query.limit) || 25)));

  r.get("/calls", (req, res) => res.json({ data: page(mine("calls", req), req).map((c) => publicCall(c, false)) }));
  r.get("/calls/:id", (req, res) => {
    const call = db.get("calls", req.params.id);
    if (!call || call.orgId !== req.org.id) return res.status(404).json({ error: "Call not found." });
    res.json(publicCall(call, true));
  });
  r.get("/leads", (req, res) => res.json({ data: page(mine("leads", req), req) }));
  r.get("/appointments", (req, res) => res.json({ data: page(mine("appointments", req), req) }));

  // Which receptionist makes the call: the one named, else the business's first active one.
  const pickAgent = (req) => {
    const agents = db.find("agents", (a) => a.orgId === req.org.id && a.active);
    return req.body?.agent_id ? agents.find((a) => a.id === req.body.agent_id) : agents[0];
  };
  const callRequest = (req, res) => {
    const b = req.body ?? {};
    const phone = normalizePhone(b.phone);
    if (phone.replace(/\D/g, "").length < 10) return res.status(400).json({ error: "phone is required (with country code)." }) && null;
    if (b.consent !== true) return res.status(400).json({ error: "consent must be true: confirm this person agreed to be called by the business." }) && null;
    const agent = pickAgent(req);
    if (!agent) return res.status(400).json({ error: "No active receptionist found (check agent_id)." }) && null;
    return { b, phone, agent };
  };

  r.post("/calls", wrap(async (req, res) => {
    const ok = callRequest(req, res);
    if (!ok) return;
    const { b, phone, agent } = ok;
    if (!String(b.goal || "").trim()) return res.status(400).json({ error: "goal is required: what should the call achieve?" });
    const row = queueAiCall(db, agent, {
      phone, name: String(b.name || "").slice(0, 80), reason: String(b.goal).slice(0, 300), goal: String(b.goal).slice(0, 1500),
      language: agentLanguages(agent).includes(b.language) ? b.language : null, source: "api", consent: true,
      when: /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") && /^\d{2}:\d{2}$/.test(b.time || "") ? { date: b.date, time: b.time } : null,
    });
    await placeDueCalls(db);
    res.status(202).json(db.get("callbacks", row.id));
  }));

  r.post("/leads", wrap(async (req, res) => {
    const b = req.body ?? {};
    const phone = normalizePhone(b.phone);
    if (!String(b.name || "").trim() || phone.replace(/\D/g, "").length < 10) return res.status(400).json({ error: "name and phone are required." });
    const agent = pickAgent(req);
    const lead = db.insert("leads", {
      orgId: req.org.id, agentId: agent?.id ?? null, callId: null, customerName: String(b.name).slice(0, 80), phone,
      interest: String(b.interest || "New enquiry").slice(0, 200), notes: String(b.notes || "").slice(0, 1000), status: "new", score: null, source: String(b.source || "api").slice(0, 40),
    });
    emitEvent(db, req.org.id, "lead.created", lead);
    let call = null;
    if (b.call_now) {
      if (b.consent !== true) return res.status(400).json({ error: "call_now needs consent: true (the person agreed to be called).", lead });
      if (!agent) return res.status(400).json({ error: "No active receptionist to make the call.", lead });
      const row = queueAiCall(db, agent, {
        phone, name: lead.customerName, reason: lead.interest, source: "lead", consent: true, leadId: lead.id,
        goal: `This person just enquired about: ${lead.interest}. ${lead.notes} Thank them, answer their questions, find out what they need and when, and book an appointment or a callback if you can. Save what you learn as a lead.`,
      });
      await placeDueCalls(db);
      call = db.get("callbacks", row.id);
    }
    res.status(201).json({ lead, call });
  }));

  r.use((req, res) => res.status(404).json({ error: "Unknown API endpoint." }));
  return r;
}
