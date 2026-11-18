// VoiceDesk Network: our own telephony. Calls arrive from (and leave
// through) a SIP trunk from a licensed Indian operator straight into
// VoiceDesk: no Twilio, Plivo, Vobiz or Exotel in between. Each call's RTP
// audio feeds the same voice pipeline (session.js) used everywhere else.
//
// Configure with environment variables:
//   SIP_ENABLED=1                 turn the gateway on
//   SIP_PORT=5060                 UDP port for SIP
//   SIP_PUBLIC_IP=203.0.113.5     the server's public IP (put in SDP/Contact)
//   RTP_PORT_MIN / RTP_PORT_MAX   UDP range for call audio (open it in the firewall)
//   SIP_TRUNK_HOST / SIP_TRUNK_PORT / SIP_TRUNK_DOMAIN
//   SIP_TRUNK_USER / SIP_TRUNK_PASS / SIP_TRUNK_REGISTER=1
//   SIP_ALLOWED_IPS=1.2.3.4,5.6.7.8   only these addresses may send us calls (the operator's)
//   SIP_DIAL_FORMAT=e164|plain|national   how the operator wants numbers (+9198…, 9198…, 098…)
import { endCall } from "../calls.js";
import { notifyOwner } from "../messaging.js";
import { normalizePhone } from "../util.js";
import { incoming, liveSessions } from "../voice/router.js";
import { VoiceSession } from "../voice/session.js";
import { SipUA } from "./ua.js";
import { greetingFor } from "../agent.js";
import { FlowError, flowProblem, runFlow } from "./flow.js";
import { fetchBytes, postJson, saveRecording } from "./records.js";

/** Filled in when the gateway starts; carriers.js uses it for the "voicedesk" carrier. */
export const sipHooks = { enabled: false, canDial: false };

const legsByCall = new Map(); // VoiceDesk call id → { leg, session }

export function dialFormat(number, format = process.env.SIP_DIAL_FORMAT || "e164") {
  const digits = String(number || "").replace(/[^\d]/g, "");
  if (format === "plain") return digits;
  if (format === "national") return `0${digits.slice(-10)}`;
  return `+${digits}`;
}

export function sipConfigFromEnv(env = process.env) {
  return {
    port: Number(env.SIP_PORT) || 5060,
    host: env.SIP_BIND || "0.0.0.0",
    publicIp: env.SIP_PUBLIC_IP || "",
    rtp: { min: Number(env.RTP_PORT_MIN) || 10000, max: Number(env.RTP_PORT_MAX) || 20000 },
    trunk: {
      host: env.SIP_TRUNK_HOST || "",
      port: Number(env.SIP_TRUNK_PORT) || 5060,
      domain: env.SIP_TRUNK_DOMAIN || "",
      username: env.SIP_TRUNK_USER || "",
      authUser: env.SIP_TRUNK_AUTH_USER || "",
      password: env.SIP_TRUNK_PASS || "",
      register: env.SIP_TRUNK_REGISTER === "1",
    },
    allowedIps: (env.SIP_ALLOWED_IPS || "").split(",").map((s) => s.trim()).filter(Boolean),
    allowAny: env.SIP_ALLOW_ANY === "1",
  };
}

/** Start the gateway. Returns the SipUA. */
export async function startSipGateway(db, config = sipConfigFromEnv()) {
  const allowed = new Set([...config.allowedIps, ...(config.trunk.host && /^\d+\.\d+\.\d+\.\d+$/.test(config.trunk.host) ? [config.trunk.host] : [])]);
  const ua = new SipUA({
    ...config,
    // Toll-fraud protection: only the operator's addresses may start calls.
    allow: config.allowAny ? null : (rinfo) => allowed.has(rinfo.address),
  });
  ua.on("error", (err) => console.error("SIP:", err.message));
  ua.on("registered", ({ expires }) => console.log(`SIP: registered with ${config.trunk.host} for ${expires}s`));
  ua.on("invite", (leg) => onInvite(db, ua, leg).catch((err) => {
    console.error("SIP inbound call failed:", err.message);
    leg.reject(500);
  }));
  await ua.start();
  Object.assign(sipHooks, {
    enabled: true,
    canDial: Boolean(config.trunk.host),
    ua,
    hangup: async (id) => {
      const leg = [...ua.calls.values()].find((l) => l.callId === id);
      if (leg) await leg.bye();
      return { ok: true };
    },
    transfer: async (id, { number, from }) => {
      const leg = [...ua.calls.values()].find((l) => l.callId === id);
      if (!leg) return { ok: false, error: "Call not found" };
      bridgeTo(ua, leg, number, from);
      return { ok: true };
    },
    dial: (args) => dial(db, ua, args),
  });
  console.log(`SIP: VoiceDesk Network listening on udp/${ua.port}${config.trunk.host ? `, trunk ${config.trunk.host}` : " (no trunk set: inbound only)"}`);
  return ua;
}

export function stopSipGateway() {
  sipHooks.ua?.stop();
  Object.assign(sipHooks, { enabled: false, canDial: false, ua: null });
}

async function onInvite(db, ua, leg) {
  const dialled = normalizePhone(leg.toUser);
  const number = db.find("numbers", (n) => n.carrier === "voicedesk" && n.number === dialled)[0];
  if (!number) return leg.reject(404);
  if (number.voiceUrl) return programmableInbound(db, ua, leg, number); // the developer's own call flow
  leg.ringing();
  const out = incoming(db, number, { from: leg.fromUser, providerCallId: leg.callId });
  if (out.refuse) {
    if (!out.human) return leg.reject(480);
    await leg.answer();
    return bridgeTo(ua, leg, out.human, number.number);
  }
  await leg.answer();
  if (leg.state === "ended") return endCall(db, out.call, "caller-hung-up");
  if (number.record) leg.rtp.startRecording();
  attach(db, out.call.id, leg);
}

/** Connect a live call leg to VoiceDesk's voice pipeline. */
function attach(db, callId, leg) {
  const session = new VoiceSession({
    db,
    carrier: "voicedesk",
    send: (msg) => {
      if (msg.event === "media") leg.rtp.play(msg.pcm);
      else if (msg.event === "clear") leg.rtp.clear();
    },
    close: () => {},
  });
  legsByCall.set(callId, { leg, session });
  liveSessions.set(callId, session);
  leg.rtp.onAudio = (pcm) => session.audio(pcm);
  leg.rtp.onDtmf = (digit) => session.dtmf(digit);
  leg.once("end", () => {
    keepRecording(db, callId, leg);
    if (legsByCall.get(callId)?.leg === leg) {
      session.closed();
      legsByCall.delete(callId);
      liveSessions.delete(callId);
    }
  });
  const call = db.get("calls", callId);
  db.update("calls", callId, { answeredAt: call.answeredAt || new Date().toISOString() });
  session.begin(db.get("calls", callId), leg.callId);
  return session;
}

/** Transfer: call `number` and connect the two legs' audio (VoiceDesk acts as a B2BUA). */
function bridgeTo(ua, leg, number, from) {
  const entry = [...legsByCall.entries()].find(([, v]) => v.leg === leg);
  if (entry) legsByCall.delete(entry[0]); // the AI is no longer on this call
  leg.rtp.onAudio = null;
  leg.rtp.onDtmf = null;
  ua.invite({ to: dialFormat(number), from: dialFormat(from || leg.toUser) })
    .then((other) => {
      const pipe = (a, b) => (pcm) => {
        if (b.rtp.queue.length > 10) b.rtp.queue.splice(0, b.rtp.queue.length - 10); // keep delay low
        b.rtp.play(pcm);
      };
      leg.rtp.onAudio = pipe(leg, other);
      other.rtp.onAudio = pipe(other, leg);
      leg.once("end", () => other.bye());
      other.once("end", () => leg.bye());
      if (leg.state === "ended") other.bye();
    })
    .catch(() => leg.bye()); // nobody answered: end politely rather than leave silence
}

/** Outbound call for a VoiceDesk call record. kind "ai" or click-to-call bridge (bridgeTo set). */
async function dial(db, ua, { from, to, callId, bridgeTo: customer }) {
  if (!sipHooks.canDial) return { ok: false, error: "No SIP trunk is configured for outbound calls." };
  const pendingId = `pending-${callId}`;
  ua.invite({ to: dialFormat(to), from: dialFormat(from) })
    .then((leg) => {
      const call = db.get("calls", callId);
      if (!call || call.status === "ended") return leg.bye();
      db.update("calls", callId, { providerCallId: leg.callId, answeredAt: new Date().toISOString() });
      if (customer) {
        bridgeTo(ua, leg, customer, from);
        leg.once("end", () => { const c = db.get("calls", callId); if (c && c.status !== "ended") endCall(db, c, "completed"); });
      } else {
        attach(db, callId, leg);
      }
    })
    .catch((err) => {
      const call = db.get("calls", callId);
      if (!call || call.status === "ended") return;
      const outcome = err.status === 486 || err.status === 600 ? "busy" : [408, 480, 487].includes(err.status) ? "no-answer" : "failed";
      if (outcome === "failed") notifyOwner(db, call.orgId, { kind: "call-failed", title: "A call couldn't be placed", body: `To ${call.callerNumber || to}: ${err.message}`, callId });
      endCall(db, call, outcome);
    });
  return { ok: true, id: pendingId };
}

/** Save the whole-call recording (if one was running) before the call record closes. */
function keepRecording(db, callId, leg) {
  const pcm = leg.rtp?.finalRecording;
  const call = db.get("calls", callId);
  if (!pcm?.length || !call || call.recordingId) return;
  leg.rtp.finalRecording = null;
  const row = saveRecording(db, { orgId: call.orgId, callId, pcm, kind: "call" });
  db.update("calls", callId, { recordingId: row.id });
}

// ---------------- Programmable calls (VoiceDesk call flows) ----------------
function flowCallRecord(db, number, extra) {
  return db.insert("calls", {
    orgId: number.orgId, agentId: number.agentId ?? null, agentName: "Call flow", channel: "api", carrier: "voicedesk",
    numberId: number.id, fromNumber: number.number, status: "live", transcript: [], messages: [], summary: "", durationSec: 0,
    flowLog: [], ...extra,
  });
}

async function programmableInbound(db, ua, leg, number) {
  leg.ringing();
  await leg.answer();
  const call = flowCallRecord(db, number, {
    direction: "inbound", callerNumber: normalizePhone(leg.fromUser), providerCallId: leg.callId,
    answeredAt: new Date().toISOString(), statusCallback: number.statusCallback || null,
  });
  if (number.record) leg.rtp.startRecording();
  runProgrammable(db, ua, leg, call.id, { answerUrl: number.voiceUrl });
}

/** Place a programmable call (Voice API). Returns the call record at once; the flow runs when answered. */
export function dialFlow(db, { number, to, flow, answerUrl, statusCallback, record }) {
  const ua = sipHooks.ua;
  const call = flowCallRecord(db, number, { direction: "outbound", callerNumber: normalizePhone(to), statusCallback: statusCallback || null });
  ua.invite({ to: dialFormat(to), from: dialFormat(number.number), onLeg: (leg) => db.update("calls", call.id, { providerCallId: leg.callId }) })
    .then((leg) => {
      const current = db.get("calls", call.id);
      if (!current || current.status === "ended") return leg.bye();
      db.update("calls", call.id, { answeredAt: new Date().toISOString() });
      if (record) leg.rtp.startRecording();
      runProgrammable(db, ua, leg, call.id, { flow, answerUrl });
    })
    .catch((err) => {
      const current = db.get("calls", call.id);
      if (!current || current.status === "ended") return;
      endCall(db, current, err.status === 486 || err.status === 600 ? "busy" : [408, 480, 487].includes(err.status) ? "no-answer" : "failed");
    });
  return call;
}

export function hangupCall(db, callId) {
  const call = db.get("calls", callId);
  const leg = call?.providerCallId && sipHooks.ua?.calls.get(call.providerCallId);
  if (leg) return leg.bye();
  if (call && call.status !== "ended") endCall(db, call, "canceled");
}

async function runProgrammable(db, ua, leg, callId, { flow, answerUrl }) {
  const call = () => db.get("calls", callId);
  const org = db.get("orgs", call().orgId);
  const about = () => {
    const c = call();
    return { call_id: callId, direction: c.direction, from: c.direction === "outbound" ? c.fromNumber : c.callerNumber, to: c.direction === "outbound" ? c.callerNumber : c.fromNumber };
  };
  const log = (event) => {
    const c = call();
    if (c) db.update("calls", callId, { flowLog: [...(c.flowLog || []), { at: new Date().toISOString(), ...event }].slice(-100) });
  };
  let handedToAi = false;
  leg.once("end", (reason) => {
    keepRecording(db, callId, leg);
    const c = call();
    if (!handedToAi && c && c.status !== "ended") endCall(db, c, reason === "local-bye" ? "completed" : "caller-hung-up");
  });
  const ctx = {
    db, org, callId, leg,
    language: db.get("agents", call().agentId)?.language || "en-IN",
    fetchFlow: async (url, payload) => {
      const res = await postJson(url, { ...about(), ...payload });
      return Array.isArray(res) ? res : res?.flow ?? null;
    },
    fetchAudio: (url) => fetchBytes(url),
    bridge: (number, callerId) => bridgeAndWait(ua, leg, number, callerId || call().fromNumber),
    startAi: (agentId) => {
      const agent = (agentId && db.find("agents", (a) => a.id === agentId && a.orgId === org.id)[0]) || db.get("agents", call().agentId) || db.find("agents", (a) => a.orgId === org.id && a.active)[0];
      if (!agent) throw new FlowError("No AI receptionist to hand the call to.");
      handedToAi = true;
      const greeting = greetingFor(agent, null, agent.language, org.name);
      db.update("calls", callId, { agentId: agent.id, agentName: agent.name, channel: "phone", language: agent.language, greeting, transcript: [{ role: "agent", text: greeting, at: new Date().toISOString() }] });
      attach(db, callId, leg);
    },
    recordingDone: (pcm, meta) => saveRecording(db, { orgId: org.id, callId, pcm, kind: meta.kind }),
    log,
  };
  try {
    const steps = flow ?? (await ctx.fetchFlow(answerUrl, { event: "call.answered" }));
    const problem = steps ? flowProblem(steps) : "The answer URL returned no flow.";
    if (problem) throw new FlowError(problem);
    const result = await runFlow(ctx, steps);
    if (result === "done" && leg.state !== "ended") {
      await leg.rtp.drained();
      await leg.bye(); // like other platforms: the call ends when the flow runs out
    }
  } catch (err) {
    log({ error: err.message });
    db.update("calls", callId, { error: err.message });
    if (leg.state !== "ended" && !handedToAi) await leg.bye();
  }
}

/** dial step: call another number and join the audio until that call ends. */
function bridgeAndWait(ua, leg, number, from) {
  return new Promise((resolve) => {
    ua.invite({ to: dialFormat(number), from: dialFormat(from) })
      .then((other) => {
        const before = leg.rtp.onAudio;
        const pipe = (b) => (pcm) => {
          if (b.rtp.queue.length > 10) b.rtp.queue.splice(0, b.rtp.queue.length - 10);
          b.rtp.play(pcm);
        };
        leg.rtp.onAudio = pipe(other);
        other.rtp.onAudio = pipe(leg);
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          leg.rtp.onAudio = before;
          resolve("completed");
        };
        other.once("end", finish);
        leg.once("end", () => { other.bye(); finish(); });
      })
      .catch((err) => resolve(err.status === 486 || err.status === 600 ? "busy" : [408, 480, 487].includes(err.status) ? "no-answer" : "failed"));
  });
}
