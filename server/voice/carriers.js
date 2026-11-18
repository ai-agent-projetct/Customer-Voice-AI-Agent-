// Phone-company adapters. VoiceDesk is not tied to one phone company: each
// adapter knows how its company
//   1. tells us a call arrived (answer webhook) and how we reply (XML),
//   2. streams the caller's audio to us over a WebSocket, and how we send our
//      voice back, interrupt it (barge-in) and mark positions,
//   3. places outbound calls, hangs up and transfers through its REST API.
// Everything else (listening, thinking, speaking) is VoiceDesk's own voice
// engine in session.js, identical for every company.
//
// Supported: Twilio (Media Streams), Plivo and Vobiz (bidirectional <Stream>),
// Exotel (Voicebot applet), and "web" (a call from the dashboard in a browser).
import { decodeMulaw, encodeMulaw, pcmFromBytes, pcmToBytes } from "./audio.js";
import { escapeXml } from "../tts.js";

/** Network seam, replaced in tests. */
export const carrierNet = { fetch: (...a) => fetch(...a) };

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;

async function result(res, idOf) {
  const text = await res.text().catch(() => "");
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) return { ok: false, error: data.message || data.error || data.RestException?.Message || `HTTP ${res.status}` };
  return { ok: true, id: idOf(data) ?? null, data };
}

// ---------------- Twilio ----------------
const twilio = {
  id: "twilio",
  label: "Twilio",
  fields: [
    { name: "accountSid", label: "Account SID", env: "TWILIO_ACCOUNT_SID" },
    { name: "authToken", label: "Auth token", env: "TWILIO_AUTH_TOKEN", secret: true },
  ],
  setup: "In Twilio → Phone Numbers → your number → Voice: 'A call comes in' → Webhook, POST, paste the Answer URL.",
  answer: (streamUrl) => xml(`<Connect><Stream url="${escapeXml(streamUrl)}"/></Connect>`),
  parseAnswer: (b) => ({ providerCallId: b.CallSid, from: b.From, to: b.To }),
  parse(m) {
    if (m.event === "start") return { type: "start", streamId: m.start?.streamSid || m.streamSid, providerCallId: m.start?.callSid };
    if (m.event === "media" && (!m.media.track || m.media.track === "inbound")) return { type: "audio", pcm: decodeMulaw(Buffer.from(m.media.payload, "base64")) };
    if (m.event === "dtmf") return { type: "dtmf", digit: String(m.dtmf?.digit ?? "") };
    if (m.event === "mark") return { type: "mark", name: m.mark?.name };
    if (m.event === "stop") return { type: "stop" };
    return null;
  },
  media: (pcm, s) => ({ event: "media", streamSid: s.streamId, media: { payload: encodeMulaw(pcm).toString("base64") } }),
  clear: (s) => ({ event: "clear", streamSid: s.streamId }),
  mark: (s, name) => ({ event: "mark", streamSid: s.streamId, mark: { name } }),
  api: (c, path) => `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}${path}`,
  async dial(c, { from, to, answerUrl, statusUrl }) {
    const res = await carrierNet.fetch(this.api(c, "/Calls.json"), {
      method: "POST",
      headers: { authorization: basic(c.accountSid, c.authToken) },
      body: new URLSearchParams({ To: to, From: from, Url: answerUrl, StatusCallback: statusUrl, StatusCallbackEvent: "completed" }),
    });
    return result(res, (d) => d.sid);
  },
  async hangup(c, id) {
    return result(await carrierNet.fetch(this.api(c, `/Calls/${id}.json`), { method: "POST", headers: { authorization: basic(c.accountSid, c.authToken) }, body: new URLSearchParams({ Status: "completed" }) }), () => id);
  },
  async transfer(c, id, { number, from }) {
    const twiml = xml(`<Dial${from ? ` callerId="${escapeXml(from)}"` : ""}>${escapeXml(number)}</Dial>`);
    return result(await carrierNet.fetch(this.api(c, `/Calls/${id}.json`), { method: "POST", headers: { authorization: basic(c.accountSid, c.authToken) }, body: new URLSearchParams({ Twiml: twiml }) }), () => id);
  },
  dialXml: (number, from) => xml(`<Dial${from ? ` callerId="${escapeXml(from)}"` : ""}>${escapeXml(number)}</Dial>`),
  sayXml: (text) => xml(`<Say>${escapeXml(text)}</Say><Hangup/>`),
};

// ---------------- Plivo (and Vobiz, which uses the same call language) ----------------
function plivoLike({ id, label, apiBase, auth, fields, setup }) {
  return {
    id,
    label,
    fields,
    setup,
    answer: (streamUrl) => xml(`<Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">${escapeXml(streamUrl)}</Stream>`),
    parseAnswer: (b) => ({ providerCallId: b.CallUUID || b.call_uuid || b.CallUuid, from: b.From || b.from, to: b.To || b.to }),
    parse(m) {
      if (m.event === "start") return { type: "start", streamId: m.start?.streamId || m.streamId, providerCallId: m.start?.callId };
      if (m.event === "media") return { type: "audio", pcm: decodeMulaw(Buffer.from(m.media?.payload || "", "base64")) };
      if (m.event === "dtmf") return { type: "dtmf", digit: String(m.dtmf?.digit ?? m.digit ?? "") };
      if (m.event === "playedStream") return { type: "mark", name: m.name };
      if (m.event === "stop") return { type: "stop" };
      return null;
    },
    media: (pcm) => ({ event: "playAudio", media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: encodeMulaw(pcm).toString("base64") } }),
    clear: (s) => ({ event: "clearAudio", streamId: s.streamId }),
    mark: (s, name) => ({ event: "checkpoint", streamId: s.streamId, name }),
    url: (c, path) => `${apiBase()}/Account/${c.authId}${path}`,
    async dial(c, { from, to, answerUrl, statusUrl }) {
      const res = await carrierNet.fetch(this.url(c, "/Call/"), {
        method: "POST",
        headers: { ...auth(c), "content-type": "application/json" },
        body: JSON.stringify({ from: from.replace(/^\+/, ""), to: to.replace(/^\+/, ""), answer_url: answerUrl, answer_method: "POST", hangup_url: statusUrl, hangup_method: "POST" }),
      });
      return result(res, (d) => d.request_uuid || d.call_uuid);
    },
    async hangup(c, callId) {
      return result(await carrierNet.fetch(this.url(c, `/Call/${callId}/`), { method: "DELETE", headers: auth(c) }), () => callId);
    },
    async transfer(c, callId, { url }) {
      const res = await carrierNet.fetch(this.url(c, `/Call/${callId}/`), {
        method: "POST",
        headers: { ...auth(c), "content-type": "application/json" },
        body: JSON.stringify({ legs: "aleg", aleg_url: url, aleg_method: "POST" }),
      });
      return result(res, () => callId);
    },
    dialXml: (number, from) => xml(`<Dial${from ? ` callerId="${escapeXml(from.replace(/^\+/, ""))}"` : ""}><Number>${escapeXml(number.replace(/^\+/, ""))}</Number></Dial>`),
    sayXml: (text) => xml(`<Speak>${escapeXml(text)}</Speak><Hangup/>`),
  };
}

const plivo = plivoLike({
  id: "plivo",
  label: "Plivo",
  apiBase: () => process.env.PLIVO_API_BASE || "https://api.plivo.com/v1",
  auth: (c) => ({ authorization: basic(c.authId, c.authToken) }),
  fields: [
    { name: "authId", label: "Auth ID", env: "PLIVO_AUTH_ID" },
    { name: "authToken", label: "Auth token", env: "PLIVO_AUTH_TOKEN", secret: true },
  ],
  setup: "In Plivo → Voice → Applications → create an XML application: Answer URL = the Answer URL below (POST). Attach your number to it.",
});

const vobiz = plivoLike({
  id: "vobiz",
  label: "Vobiz",
  apiBase: () => process.env.VOBIZ_API_BASE || "https://api.vobiz.ai/api/v1",
  auth: (c) => ({ "X-Auth-ID": c.authId, "X-Auth-Token": c.authToken }),
  fields: [
    { name: "authId", label: "Auth ID", env: "VOBIZ_AUTH_ID" },
    { name: "authToken", label: "Auth token", env: "VOBIZ_AUTH_TOKEN", secret: true },
  ],
  setup: "In Vobiz → Applications → create an application with Answer URL = the Answer URL below (POST), then link your number to it.",
});

// ---------------- Exotel ----------------
const exotel = {
  id: "exotel",
  label: "Exotel",
  fields: [
    { name: "accountSid", label: "Account SID", env: "EXOTEL_ACCOUNT_SID" },
    { name: "apiKey", label: "API key", env: "EXOTEL_API_KEY" },
    { name: "apiToken", label: "API token", env: "EXOTEL_API_TOKEN", secret: true },
    { name: "subdomain", label: "API region (api.exotel.com or api.in.exotel.com)", env: "EXOTEL_SUBDOMAIN" },
    { name: "flowId", label: "App (flow) ID with the Voicebot applet", env: "EXOTEL_FLOW_ID" },
  ],
  setup: "In Exotel → App Bazaar → create a flow: Voicebot applet with the Stream URL below, then a Connect applet to your team (used when the AI transfers), then Hangup. Assign your ExoPhone to the flow.",
  streamOnly: true, // no answer XML: the flow opens the stream
  parse(m, opts = {}) {
    if (m.event === "start") {
      const s = m.start || {};
      return { type: "start", streamId: m.stream_sid || s.stream_sid, providerCallId: s.call_sid || s.callSid, from: s.from, to: s.to, custom: s.custom_parameters || {} };
    }
    if (m.event === "media") {
      const bytes = Buffer.from(m.media?.payload || "", "base64");
      return { type: "audio", pcm: opts.encoding === "mulaw" ? decodeMulaw(bytes) : pcmFromBytes(bytes) };
    }
    if (m.event === "dtmf") return { type: "dtmf", digit: String(m.dtmf?.digit ?? "") };
    if (m.event === "mark") return { type: "mark", name: m.mark?.name };
    if (m.event === "stop") return { type: "stop" };
    return null;
  },
  media: (pcm, s, opts = {}) => ({ event: "media", stream_sid: s.streamId, media: { payload: (opts.encoding === "mulaw" ? encodeMulaw(pcm) : pcmToBytes(pcm)).toString("base64") } }),
  clear: (s) => ({ event: "clear", stream_sid: s.streamId }),
  mark: (s, name) => ({ event: "mark", stream_sid: s.streamId, mark: { name } }),
  url: (c, path) => `https://${c.subdomain || "api.exotel.com"}/v1/Accounts/${c.accountSid}${path}`,
  async dial(c, { from, to, statusUrl, callId, bridgeTo }) {
    const body = bridgeTo
      ? { From: to, To: bridgeTo, CallerId: from, StatusCallback: statusUrl } // ring `to` (owner), then connect bridgeTo
      : { From: to, CallerId: from, Url: `http://my.exotel.com/${c.accountSid}/exoml/start_voice/${c.flowId}`, CallType: "trans", StatusCallback: statusUrl, CustomField: callId };
    const res = await carrierNet.fetch(this.url(c, "/Calls/connect.json"), {
      method: "POST",
      headers: { authorization: basic(c.apiKey, c.apiToken) },
      body: new URLSearchParams(body),
    });
    return result(res, (d) => d.Call?.Sid);
  },
  // Exotel continues the flow when the stream closes: the Connect applet transfers, Hangup ends.
  async hangup() { return { ok: true, viaStream: true }; },
  async transfer() { return { ok: true, viaStream: true }; },
};

// ---------------- Browser (dashboard test calls) ----------------
const web = {
  id: "web",
  label: "Browser",
  fields: [],
  internal: true,
  parse(m) {
    if (m.event === "start") return { type: "start", streamId: "web" };
    if (m.event === "media") return { type: "audio", pcm: pcmFromBytes(Buffer.from(m.payload || "", "base64")) };
    if (m.event === "text" && String(m.text || "").trim()) return { type: "text", text: String(m.text).trim().slice(0, 2000) };
    if (m.event === "dtmf") return { type: "dtmf", digit: String(m.digit ?? "") };
    if (m.event === "stop") return { type: "stop" };
    return null;
  },
  media: (pcm) => ({ event: "media", payload: pcmToBytes(pcm).toString("base64") }),
  clear: () => ({ event: "clear" }),
  mark: (s, name) => ({ event: "mark", name }),
  async hangup() { return { ok: true, viaStream: true }; },
  async transfer() { return { ok: true, viaStream: true }; },
};

export const CARRIERS = { twilio, plivo, vobiz, exotel, web };
export const PHONE_CARRIERS = ["twilio", "plivo", "vobiz", "exotel"];

/** The business's login for a phone company: saved in Settings, else environment variables. */
export function credsFor(org, carrier) {
  const adapter = CARRIERS[carrier];
  const saved = org?.carriers?.[carrier] || {};
  const out = {};
  for (const f of adapter?.fields ?? []) out[f.name] = saved[f.name] || process.env[f.env] || "";
  return out;
}

export function carrierReady(org, carrier) {
  const adapter = CARRIERS[carrier];
  if (!adapter) return false;
  const c = credsFor(org, carrier);
  return adapter.fields.filter((f) => f.name !== "subdomain").every((f) => c[f.name]);
}
