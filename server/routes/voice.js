// Dashboard API for "Phone & voice": connect phone companies (Twilio, Plivo,
// Vobiz, Exotel), add phone numbers, choose the voice engine (ears and
// mouth), preview voices, and make test calls through the full pipeline.
// Secrets (auth tokens, API keys) are stored on the business and never sent
// back: the dashboard only sees whether each one is set and its last 4 characters.
import express from "express";
import { agentLanguages, lang } from "../languages.js";
import { normalizePhone } from "../util.js";
import { startCall } from "../calls.js";
import { greetingFor } from "../agent.js";
import { CARRIERS, PHONE_CARRIERS, carrierReady, credsFor } from "../voice/carriers.js";
import { KEY_ENV, STT_ENGINES, TTS_ENGINES, chooseEngines, keyFor, previewWav, voiceSettings } from "../voice/engines.js";
import { numberUrls, placeCall, startWebCall, token } from "../voice/router.js";
import { owned, wrap } from "./helpers.js";

const last4 = (v) => (v ? `…${String(v).slice(-4)}` : null);

export function voiceRouter(db, auth) {
  const r = express.Router();
  r.use(auth);

  const numberView = (n) => ({
    id: n.id, number: n.number, carrier: n.carrier, label: n.label || "", agentId: n.agentId || null,
    agentName: n.agentId ? db.get("agents", n.agentId)?.name ?? null : null,
    outbound: n.outbound !== false, ...numberUrls(n),
  });

  r.get("/phone-voice", (req, res) => {
    const org = req.org;
    const carriers = PHONE_CARRIERS.map((id) => {
      const a = CARRIERS[id];
      const saved = org.carriers?.[id] || {};
      const creds = credsFor(org, id);
      return {
        id, label: a.label, setup: a.setup, ready: carrierReady(org, id),
        fields: a.fields.map((f) => ({
          name: f.name, label: f.label, secret: Boolean(f.secret),
          value: f.secret ? null : saved[f.name] || "",
          set: Boolean(creds[f.name]), last4: f.secret ? last4(creds[f.name]) : null,
          fromEnv: !saved[f.name] && Boolean(process.env[f.env]),
        })),
        ...(id === "exotel" && { encoding: saved.encoding === "mulaw" ? "mulaw" : "slin" }),
      };
    });
    const settings = voiceSettings(org);
    const keys = Object.fromEntries(Object.keys(KEY_ENV).map((k) => [k, { set: Boolean(keyFor(org, k)), last4: last4(keyFor(org, k)), fromEnv: !org.voiceKeys?.[k] && Boolean(process.env[KEY_ENV[k]]) }]));
    const agents = db.find("agents", (a) => a.orgId === org.id);
    const readiness = agents.map((a) => ({
      agentId: a.id, agentName: a.name,
      languages: agentLanguages(a).map((code) => ({ code, name: lang(code).name, ...chooseEngines(org, code) })),
    }));
    res.json({
      publicUrl: process.env.PUBLIC_URL || null,
      carriers,
      numbers: db.find("numbers", (n) => n.orgId === org.id).map(numberView),
      engines: {
        stt: settings.stt, tts: settings.tts, voices: settings.voices, customTtsUrl: settings.customTtsUrl, keys,
        sttOptions: STT_ENGINES, ttsOptions: TTS_ENGINES,
      },
      readiness,
      agents: agents.map((a) => ({ id: a.id, name: a.name, languages: agentLanguages(a) })),
    });
  });

  r.put("/phone-voice/carriers/:carrier", (req, res) => {
    const adapter = CARRIERS[req.params.carrier];
    if (!adapter || adapter.internal) return res.status(404).json({ error: "Unknown phone company." });
    const body = req.body || {};
    const current = { ...(req.org.carriers?.[adapter.id] || {}) };
    for (const f of adapter.fields) {
      if (!(f.name in body)) continue;
      const value = String(body[f.name] ?? "").trim().slice(0, 300);
      if (f.secret && !value && !body.clear) continue; // empty secret field = keep the saved one
      current[f.name] = value;
    }
    if (body.clear) for (const f of adapter.fields) delete current[f.name];
    if (adapter.id === "exotel" && body.encoding) current.encoding = body.encoding === "mulaw" ? "mulaw" : "slin";
    if (current.subdomain && !/^[a-z0-9.-]+\.exotel\.(com|in)$/i.test(current.subdomain)) {
      return res.status(400).json({ error: "API region must look like api.exotel.com or api.in.exotel.com." });
    }
    db.update("orgs", req.org.id, { carriers: { ...(req.org.carriers || {}), [adapter.id]: current } });
    res.json({ ok: true, ready: carrierReady(db.get("orgs", req.org.id), adapter.id) });
  });

  r.put("/phone-voice/engines", (req, res) => {
    const body = req.body || {};
    const settings = voiceSettings(req.org);
    if (body.stt) {
      if (body.stt !== "auto" && !STT_ENGINES[body.stt]) return res.status(400).json({ error: "Unknown speech-to-text engine." });
      settings.stt = body.stt;
    }
    if (body.tts) {
      if (body.tts !== "auto" && !TTS_ENGINES[body.tts]) return res.status(400).json({ error: "Unknown voice engine." });
      settings.tts = body.tts;
    }
    if (body.voices && typeof body.voices === "object") {
      settings.voices = Object.fromEntries(Object.entries(body.voices).filter(([k, v]) => /^[a-z]{2}(-[A-Z]{2})?$/.test(k) && typeof v === "string").map(([k, v]) => [k, v.trim().slice(0, 120)]).filter(([, v]) => v));
    }
    if ("customTtsUrl" in body) {
      const url = String(body.customTtsUrl || "").trim();
      if (url && !/^https:\/\/[^\s]+$/i.test(url) && !(process.env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url))) {
        return res.status(400).json({ error: "Your voice server URL must start with https://" });
      }
      settings.customTtsUrl = url;
    }
    const keys = { ...(req.org.voiceKeys || {}) };
    for (const [name, value] of Object.entries(body.keys || {})) {
      if (!(name in KEY_ENV)) continue;
      const v = String(value ?? "").trim().slice(0, 300);
      if (v) keys[name] = v;
    }
    for (const name of body.clearKeys || []) delete keys[name];
    db.update("orgs", req.org.id, { voice: settings, voiceKeys: keys });
    res.json({ ok: true });
  });

  // ---------- Numbers ----------
  r.post("/phone-voice/numbers", (req, res) => {
    const { carrier, agentId, label } = req.body || {};
    if (!PHONE_CARRIERS.includes(carrier)) return res.status(400).json({ error: "Choose a phone company." });
    const number = normalizePhone(String(req.body?.number || ""));
    if (!/^\+\d{8,15}$/.test(number)) return res.status(400).json({ error: "Enter the phone number with country code, e.g. +91 80 4567 8901." });
    if (db.find("numbers", (n) => n.number === number).length) return res.status(400).json({ error: "This number is already added." });
    if (agentId && !db.find("agents", (a) => a.id === agentId && a.orgId === req.org.id).length) return res.status(400).json({ error: "Receptionist not found." });
    const row = db.insert("numbers", {
      orgId: req.org.id, number, carrier, agentId: agentId || null, label: String(label || "").slice(0, 60),
      outbound: req.body?.outbound !== false, token: token(),
    });
    res.status(201).json(numberView(row));
  });

  r.patch("/phone-voice/numbers/:id", (req, res) => {
    const row = owned(db, "numbers", req, res, "Number not found.");
    if (!row) return;
    const changes = {};
    if ("agentId" in req.body) {
      if (req.body.agentId && !db.find("agents", (a) => a.id === req.body.agentId && a.orgId === req.org.id).length) return res.status(400).json({ error: "Receptionist not found." });
      changes.agentId = req.body.agentId || null;
    }
    if ("outbound" in req.body) changes.outbound = Boolean(req.body.outbound);
    if ("label" in req.body) changes.label = String(req.body.label || "").slice(0, 60);
    if (req.body.rotate) changes.token = token();
    res.json(numberView(db.update("numbers", row.id, changes)));
  });

  r.delete("/phone-voice/numbers/:id", (req, res) => {
    const row = owned(db, "numbers", req, res, "Number not found.");
    if (row) res.json({ ok: db.remove("numbers", row.id) });
  });

  // ---------- Try it ----------
  r.post("/phone-voice/preview", wrap(async (req, res) => {
    const language = String(req.body?.language || "en-IN");
    const agent = db.find("agents", (a) => a.orgId === req.org.id)[0];
    const text = String(req.body?.text || "").trim().slice(0, 300) || (agent ? greetingFor(agent, null, language, req.org.name) : "Hello! Thanks for calling. How can I help you today?");
    const engine = req.body?.engine && req.body.engine !== "auto" ? req.body.engine : chooseEngines(req.org, language).tts;
    if (!engine) return res.status(400).json({ error: "No voice is set up yet. Add an ElevenLabs, Sarvam or Deepgram key, or your own voice server." });
    try {
      const wav = await previewWav({ engine, org: req.org, text, language, voice: req.body?.voice || undefined });
      res.type("audio/wav").set("X-Voice-Engine", engine).send(wav);
    } catch (err) {
      res.status(502).json({ error: `The voice engine didn't answer: ${err.message}` });
    }
  }));

  r.post("/phone-voice/web-call", (req, res) => {
    const agent = db.find("agents", (a) => a.id === req.body?.agentId && a.orgId === req.org.id)[0];
    if (!agent) return res.status(400).json({ error: "Choose a receptionist." });
    const { call, url } = startWebCall(db, agent);
    const engines = chooseEngines(req.org, call.language, "web");
    res.status(201).json({ callId: call.id, url, engines: { stt: engines.stt, tts: engines.tts }, language: call.language, greeting: call.greeting });
  });

  r.post("/phone-voice/test-call", wrap(async (req, res) => {
    const agent = db.find("agents", (a) => a.id === req.body?.agentId && a.orgId === req.org.id)[0];
    if (!agent) return res.status(400).json({ error: "Choose a receptionist." });
    const to = normalizePhone(String(req.body?.to || req.org.ownerPhone || ""));
    if (!/^\+\d{8,15}$/.test(to)) return res.status(400).json({ error: "Add your mobile number to receive the test call." });
    // Test calls only go to the business's own phone, never to customers.
    if (to !== normalizePhone(req.org.ownerPhone || "") && !db.find("users", (u) => u.orgId === req.org.id && u.phone && normalizePhone(u.phone) === to).length) {
      return res.status(400).json({ error: "Test calls can only go to your own mobile number (Settings → Business)." });
    }
    const call = startCall(db, agent, { channel: "phone", direction: "outbound", callerNumber: to, silences: 0, voiceTest: true });
    const placed = await placeCall(db, { call, to });
    if (!placed.ok) {
      db.remove("calls", call.id);
      return res.status(400).json({ error: placed.error });
    }
    res.status(201).json({ callId: call.id, carrier: db.get("calls", call.id)?.carrier || "twilio" });
  }));

  return r;
}
