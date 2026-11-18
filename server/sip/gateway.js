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
  leg.ringing();
  const out = incoming(db, number, { from: leg.fromUser, providerCallId: leg.callId });
  if (out.refuse) {
    if (!out.human) return leg.reject(480);
    await leg.answer();
    return bridgeTo(ua, leg, out.human, number.number);
  }
  await leg.answer();
  if (leg.state === "ended") return endCall(db, out.call, "caller-hung-up");
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
