// HTTP and WebSocket endpoints for VoiceDesk's own voice pipeline, for every
// phone company. URLs carry a secret token (per number for incoming calls,
// per call for everything else), so only the phone company that was given
// the URL can use it.
//
//   POST /voice/:carrier/answer/:numberId/:token    a call came in → XML that opens the stream
//   POST /voice/:carrier/outbound/:callId/:token    our outbound call was answered → XML
//   POST /voice/:carrier/bridge/:callId/:token      click-to-call: owner answered → dial customer
//   POST /voice/:carrier/dial/:callId/:token        AI transfer → dial the team
//   POST /voice/:carrier/status/:callId/:token      call finished (busy, no answer, duration)
//   WS   /stream/:carrier/:callId/:token            live audio for one call
//   WS   /stream/exotel/number/:numberId/:token     Exotel's Voicebot applet (per number)
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import { endCall, startCall } from "../calls.js";
import { notifyOwner } from "../messaging.js";
import { canTakeCalls } from "../plans.js";
import { dialer, publicUrl } from "../telephony.js";
import { normalizePhone } from "../util.js";
import { CARRIERS, carrierReady, credsFor } from "./carriers.js";
import { chooseEngines } from "./engines.js";
import { VoiceSession } from "./session.js";

export const token = () => crypto.randomBytes(18).toString("base64url");

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function streamToken(db, call) {
  if (!call.streamToken) {
    call.streamToken = token();
    db.update("calls", call.id, { streamToken: call.streamToken });
  }
  return call.streamToken;
}

const wsBase = () => (process.env.PUBLIC_URL || "").replace(/\/$/, "").replace(/^http/, "ws");

/** URLs a business pastes into its phone company's console for one number. */
export function numberUrls(number) {
  const urls = {};
  if (number.carrier === "voicedesk") return urls; // calls arrive over our own SIP trunk
  if (number.carrier === "exotel") urls.streamUrl = `${wsBase()}/stream/exotel/number/${number.id}/${number.token}`;
  else urls.answerUrl = publicUrl(`/voice/${number.carrier}/answer/${number.id}/${number.token}`);
  return urls;
}

/**
 * Accept or refuse an incoming call on one of the business's numbers.
 * Returns { call } or { refuse, human }.
 */
export function incoming(db, number, { from, providerCallId }) {
  const agent = number.agentId && db.get("agents", number.agentId);
  const org = db.get("orgs", number.orgId);
  if (!agent || !agent.active || !org) return { refuse: "Sorry, this number is not set up yet. Goodbye." };
  const human = agent.transferNumber || org.ownerPhone;
  if (!canTakeCalls(db, org)) {
    notifyOwner(db, org.id, { kind: "limit", title: "Plan minutes used up", body: `A call from ${from || "a caller"} was passed to you. Upgrade to keep your receptionist answering.`, urgent: true });
    return { refuse: "Sorry, we can't take your call right now. Please try again later. Goodbye.", human };
  }
  const engines = chooseEngines(org, agent.language, number.carrier);
  if (!engines.stt || !engines.tts) {
    notifyOwner(db, org.id, { kind: "setup", title: "Calls can't be answered yet", body: `Add ${engines.missing.join(" and ")} in Settings → Phone & voice. A call from ${from || "a caller"} was passed to you.`, urgent: true });
    return { refuse: "Sorry, we can't take your call right now. Please try again later. Goodbye.", human };
  }
  const call = startCall(db, agent, {
    channel: "phone", callerNumber: normalizePhone(from || ""), carrier: number.carrier,
    numberId: number.id, providerCallId: providerCallId || "", silences: 0,
  });
  streamToken(db, call);
  return { call };
}

export function voiceRouter(db) {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }), express.json({ limit: "100kb" }));
  const params = (req) => ({ ...req.query, ...(req.body || {}) });
  const sendXml = (res, body) => res.type("text/xml").send(body);
  const adapterOf = (req, res) => {
    const a = CARRIERS[req.params.carrier];
    if (!a || a.internal || a.streamOnly && !["status", "bridge"].includes(req.path.split("/")[2])) {
      res.sendStatus(404);
      return null;
    }
    return a;
  };
  const callFor = (req, res) => {
    const call = db.get("calls", req.params.callId);
    if (!call || !safeEqual(call.streamToken, req.params.token) || call.carrier !== req.params.carrier) {
      res.sendStatus(404);
      return null;
    }
    return call;
  };

  r.all("/:carrier/answer/:numberId/:token", (req, res) => {
    const adapter = adapterOf(req, res);
    if (!adapter) return;
    const number = db.get("numbers", req.params.numberId);
    if (!number || number.carrier !== adapter.id || !safeEqual(number.token, req.params.token)) return res.sendStatus(404);
    const info = adapter.parseAnswer(params(req));
    const out = incoming(db, number, info);
    if (out.refuse) return sendXml(res, out.human ? adapter.dialXml(out.human, number.number) : adapter.sayXml(out.refuse));
    sendXml(res, adapter.answer(`${wsBase()}/stream/${adapter.id}/${out.call.id}/${out.call.streamToken}`));
  });

  r.all("/:carrier/outbound/:callId/:token", (req, res) => {
    const adapter = adapterOf(req, res);
    const call = adapter && callFor(req, res);
    if (!call) return;
    if (call.status === "ended") return sendXml(res, adapter.sayXml(""));
    const info = adapter.parseAnswer(params(req));
    db.update("calls", call.id, { answeredAt: new Date().toISOString(), providerCallId: info.providerCallId || call.providerCallId });
    sendXml(res, adapter.answer(`${wsBase()}/stream/${adapter.id}/${call.id}/${call.streamToken}`));
  });

  r.all("/:carrier/bridge/:callId/:token", (req, res) => {
    const adapter = adapterOf(req, res);
    const call = adapter && callFor(req, res);
    if (!call) return;
    const from = call.numberId && db.get("numbers", call.numberId)?.number;
    db.update("calls", call.id, { answeredAt: new Date().toISOString() });
    sendXml(res, adapter.dialXml(call.callerNumber, from));
  });

  r.all("/:carrier/dial/:callId/:token", (req, res) => {
    const adapter = adapterOf(req, res);
    const call = adapter && callFor(req, res);
    if (!call) return;
    const from = call.numberId && db.get("numbers", call.numberId)?.number;
    if (!call.transferTo) return sendXml(res, adapter.sayXml("Sorry, nobody is available right now. Goodbye."));
    sendXml(res, adapter.dialXml(call.transferTo, from));
  });

  r.all("/:carrier/status/:callId/:token", (req, res) => {
    const call = db.get("calls", req.params.callId);
    if (!call || !safeEqual(call.streamToken, req.params.token) || call.carrier !== req.params.carrier) return res.sendStatus(404);
    const p = params(req);
    const status = String(p.CallStatus || p.Status || p.call_status || p.HangupCause || "").toLowerCase().replace(/_/g, "-");
    const duration = Number(p.CallDuration || p.Duration || p.ConversationDuration || p.BillDuration || 0) || undefined;
    if (call.status !== "ended") {
      const outcome = ["busy", "no-answer", "failed", "canceled"].find((s) => status.includes(s))
        ?? (status.includes("no answer") || status.includes("noanswer") ? "no-answer" : null)
        ?? (call.answeredAt ? (call.handoff ? "transferred" : "caller-hung-up") : "no-answer");
      endCall(db, call, outcome, duration);
    } else if (duration) {
      db.update("calls", call.id, { durationSec: duration });
    }
    res.sendStatus(204);
  });

  return r;
}

// ---------------- Live audio streams ----------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

/** Called from the server's upgrade handler for paths under /stream/. Returns false if not ours. */
export function handleStreamUpgrade(db, req, socket, head) {
  const path = new URL(req.url, "http://x").pathname;
  const reject = () => {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return true;
  };
  let m = /^\/stream\/exotel\/number\/([\w-]+)\/([\w-]+)$/.exec(path);
  if (m) {
    const number = db.get("numbers", m[1]);
    if (!number || number.carrier !== "exotel" || !safeEqual(number.token, m[2])) return reject();
    wss.handleUpgrade(req, socket, head, (ws) => runStream(db, ws, "exotel", { number }));
    return true;
  }
  m = /^\/stream\/(twilio|plivo|vobiz|exotel|web)\/([\w-]+)\/([\w-]+)$/.exec(path);
  if (!m) return path.startsWith("/stream/") ? reject() : false;
  const call = db.get("calls", m[2]);
  if (!call || call.status === "ended" || call.carrier !== m[1] || !safeEqual(call.streamToken, m[3])) return reject();
  wss.handleUpgrade(req, socket, head, (ws) => runStream(db, ws, m[1], { call }));
  return true;
}

export const liveSessions = new Map(); // callId → VoiceSession (for tests and the live view)

function runStream(db, ws, carrier, { call, number }) {
  const org = db.get("orgs", (call || number).orgId);
  const options = carrier === "exotel" ? { encoding: org?.carriers?.exotel?.encoding === "mulaw" ? "mulaw" : "slin" } : {};
  const session = new VoiceSession({
    db, carrier, options,
    send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
    close: () => setTimeout(() => ws.readyState === ws.OPEN && ws.close(), 200).unref?.(),
  });
  const adapter = CARRIERS[carrier];
  let started = false;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const ev = adapter.parse(msg, options);
    if (!ev) return;
    if (ev.type === "start" && !started) {
      started = true;
      let active = call ? db.get("calls", call.id) : null;
      if (!active && number) {
        // Exotel: our own outbound call (matched by Exotel's call id or our CustomField), else a new incoming call.
        active = db.find("calls", (c) => c.status === "live" && c.carrier === "exotel" && ((ev.providerCallId && c.providerCallId === ev.providerCallId) || c.id === ev.custom?.CustomField || c.id === ev.custom?.customField))[0];
        if (!active) {
          const out = incoming(db, number, { from: ev.from, providerCallId: ev.providerCallId });
          if (out.refuse) return ws.close(); // the flow continues to its next applet (Connect to your team)
          active = out.call;
        }
      }
      if (!active || active.status === "ended") return ws.close();
      if (ev.providerCallId && !active.providerCallId) db.update("calls", active.id, { providerCallId: ev.providerCallId });
      liveSessions.set(active.id, session);
      session.begin(active, ev.streamId);
    } else if (!started) {
      return;
    } else if (ev.type === "audio") session.audio(ev.pcm);
    else if (ev.type === "text") session.heard(ev.text);
    else if (ev.type === "dtmf") session.dtmf(ev.digit);
    else if (ev.type === "stop") {
      session.closed();
      ws.close();
    }
  });
  ws.on("close", () => {
    session.closed();
    if (session.callId) liveSessions.delete(session.callId);
  });
  ws.on("error", () => {});
}

// ---------------- Outbound calls ----------------
/** The business's number to call out from: one linked to this receptionist first. */
export function outboundNumber(db, orgId, agentId) {
  const org = db.get("orgs", orgId);
  const usable = db.find("numbers", (n) => n.orgId === orgId && n.outbound !== false && carrierReady(org, n.carrier));
  return usable.find((n) => n.agentId === agentId) ?? usable[0] ?? null;
}

/**
 * Place a call for `call` to `to`. kind "ai": the AI talks to whoever answers.
 * kind "bridge": ring `to` (the owner) and connect them to call.callerNumber.
 * Uses the business's own phone company and number when set up; otherwise
 * the platform's Twilio account (the older Twilio-voice path).
 */
export async function placeCall(db, { call, to, kind = "ai" }) {
  const number = outboundNumber(db, call.orgId, call.agentId);
  if (!number) {
    const path = kind === "bridge" ? `/twilio/bridge/${call.id}` : `/twilio/outbound/${call.id}`;
    const placed = await dialer.call({ to, url: publicUrl(path), statusCallback: publicUrl("/twilio/status") });
    if (placed.ok) db.update("calls", call.id, { twilioSid: placed.sid });
    return placed;
  }
  if (!process.env.PUBLIC_URL && number.carrier !== "voicedesk") return { ok: false, error: "Set PUBLIC_URL so the phone company can reach VoiceDesk." };
  const org = db.get("orgs", call.orgId);
  const adapter = CARRIERS[number.carrier];
  const t = streamToken(db, call);
  db.update("calls", call.id, { carrier: number.carrier, numberId: number.id });
  const placed = await adapter.dial(credsFor(org, number.carrier), {
    from: number.number,
    to,
    callId: call.id,
    answerUrl: publicUrl(`/voice/${number.carrier}/${kind === "bridge" ? "bridge" : "outbound"}/${call.id}/${t}`),
    statusUrl: publicUrl(`/voice/${number.carrier}/status/${call.id}/${t}`),
    ...(kind === "bridge" && { bridgeTo: call.callerNumber }),
  }).catch((err) => ({ ok: false, error: err.message }));
  if (placed.ok) {
    db.update("calls", call.id, { providerCallId: placed.id || "", ...(number.carrier === "twilio" && { twilioSid: placed.id }) });
    return { ok: true, sid: placed.id };
  }
  return { ok: false, error: `${adapter.label}: ${placed.error}` };
}

/** A browser test call through the full voice pipeline (no phone company). */
export function startWebCall(db, agent) {
  const call = startCall(db, agent, { channel: "web", carrier: "web", voiceTest: true });
  return { call, url: `/stream/web/${call.id}/${streamToken(db, call)}` };
}
