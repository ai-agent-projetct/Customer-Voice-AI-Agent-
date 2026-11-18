// VoiceDesk's own voice pipeline on every phone company: Twilio, Plivo,
// Vobiz, Exotel and the browser. Phone companies are played by a WebSocket
// test client speaking each company's stream protocol; speech engines
// (Deepgram, Sarvam, ElevenLabs, your own voice server) by local fake servers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { Store } from "../server/db.js";
import { createApp } from "../server/index.js";
import { attachRealtime } from "../server/realtime.js";
import { transport } from "../server/messaging.js";
import { dialer } from "../server/telephony.js";
import { buildWav, decodeMulaw, encodeMulaw, mulawToLinear, linearToMulaw, parseWav, pcmToBytes, resample, tone } from "../server/voice/audio.js";
import { carrierNet } from "../server/voice/carriers.js";
import { ENDPOINTS, chooseEngines, mockTtsLog, openStt, synthesize } from "../server/voice/engines.js";
import { liveSessions, placeCall } from "../server/voice/router.js";
import { startCall } from "../server/calls.js";

delete process.env.ANTHROPIC_API_KEY;
for (const k of ["DEEPGRAM_API_KEY", "SARVAM_API_KEY", "ELEVENLABS_API_KEY", "CUSTOM_TTS_URL", "TWILIO_AUTH_TOKEN"]) delete process.env[k];
process.env.SIGNUP_RATE_LIMIT = "1000";
process.env.VOICE_SILENCE_MS = "60000";

const db = new Store(null);
let server, base;
const legacy = [];
const rest = [];
transport.send = async () => ({ status: "sent" });
dialer.call = async (args) => (legacy.push(args), { ok: true, sid: `CAV${legacy.length}` });
carrierNet.fetch = async (url, init = {}) => {
  rest.push({ url: String(url), init });
  const body = String(url).includes("exotel") ? { Call: { Sid: "EXO123" } } : String(url).includes("twilio") ? { sid: "CA123" } : { request_uuid: "PLV123", message: "call fired" };
  return new Response(JSON.stringify(body), { status: 201, headers: { "content-type": "application/json" } });
};

before(async () => {
  server = createApp(db).listen(0);
  await new Promise((r) => server.once("listening", r));
  attachRealtime(server, db);
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_URL = base;
});
after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function api(token, method, path, body) {
  const res = await fetch(base + "/api" + path, {
    method,
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()), type };
}

let n = 0;
async function business() {
  n++;
  const { body } = await api(null, "POST", "/auth/signup", { businessName: `Voice ${n}`, name: "Owner", email: `voice${n}@x.in`, password: "password123" });
  db.update("orgs", body.org.id, { plan: "business", ownerPhone: `+9198450000${String(n).padStart(2, "0")}` });
  const agent = (await api(body.token, "POST", "/agents", { templateId: "salon" })).body;
  return { token: body.token, org: body.org, agent };
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};

/** A fake phone company connected to a stream URL. */
async function phoneLine(url) {
  const ws = new WebSocket(url);
  const got = [];
  ws.on("message", (m) => got.push(JSON.parse(m)));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return { ws, got, send: (m) => ws.send(JSON.stringify(m)) };
}

// ---------------- Audio ----------------
test("audio: μ-law, WAV and resampling round-trip", () => {
  for (const s of [0, 1, -1, 100, -100, 1000, -5000, 20000, -32000]) {
    const back = mulawToLinear(linearToMulaw(s));
    assert.ok(Math.abs(back - s) <= Math.max(8, Math.abs(s) * 0.07), `${s} → ${back}`);
  }
  const t = tone(100);
  assert.equal(t.length, 800);
  assert.equal(decodeMulaw(encodeMulaw(t)).length, 800);
  const { pcm, rate } = parseWav(buildWav(t, 8000));
  assert.equal(rate, 8000);
  assert.deepEqual(Array.from(pcm.slice(0, 50)), Array.from(t.slice(0, 50)));
  assert.equal(resample(t, 8000, 16000).length, 1600);
  assert.equal(resample(resample(t, 8000, 24000), 24000, 8000).length, 800);
});

// ---------------- Engine choice ----------------
test("engine choice: Sarvam for Indian languages, Deepgram/ElevenLabs for English, clear list of what's missing", () => {
  const org = { voiceKeys: { sarvam: "s", deepgram: "d", elevenlabs: "e" } };
  const prev = process.env.VOICE_ENGINE;
  delete process.env.VOICE_ENGINE;
  try {
    assert.deepEqual(chooseEngines(org, "ta-IN"), { stt: "sarvam", tts: "sarvam", missing: [] });
    assert.deepEqual(chooseEngines(org, "en-IN"), { stt: "deepgram", tts: "elevenlabs", missing: [] });
    assert.equal(chooseEngines({ ...org, voice: { customTtsUrl: "https://voice.example/tts" } }, "hi-IN").tts, "custom");
    assert.equal(chooseEngines({ voiceKeys: { sarvam: "s" }, voice: { stt: "deepgram" } }, "en-IN").stt, null);
    const none = chooseEngines({}, "en-IN");
    assert.equal(none.missing.length, 2);
    assert.deepEqual(chooseEngines({}, "en-IN", "web"), { stt: "browser", tts: "browser", missing: [] });
  } finally {
    if (prev) process.env.VOICE_ENGINE = prev;
  }
});

// ---------------- Speech engines against fake servers ----------------
test("speech engines: Deepgram streaming ears, ElevenLabs/Sarvam/Deepgram/own-server voices", async () => {
  const fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      fake.requests.push({ url: req.url, headers: req.headers, body });
      if (req.url.startsWith("/v1/text-to-speech/")) return res.end(encodeMulaw(tone(250))); // ElevenLabs μ-law 8k
      if (req.url === "/sarvam-tts") return res.end(JSON.stringify({ audios: [buildWav(tone(500, 440, 22050), 22050).toString("base64")] }));
      if (req.url.startsWith("/v1/speak")) return res.end(pcmToBytes(tone(300)));
      if (req.url === "/my-voice") { res.setHeader("content-type", "audio/wav"); return res.end(buildWav(tone(400, 300, 16000), 16000)); }
      res.statusCode = 404;
      res.end();
    });
  });
  fake.requests = [];
  const wss = new WebSocketServer({ server: fake });
  const heardAudio = [];
  wss.on("connection", (ws, req) => {
    fake.requests.push({ url: req.url, headers: req.headers });
    ws.on("message", (m, binary) => {
      if (!binary) return;
      heardAudio.push(m.length);
      if (heardAudio.length === 3) {
        ws.send(JSON.stringify({ type: "SpeechStarted" }));
        ws.send(JSON.stringify({ type: "Results", is_final: true, speech_final: false, channel: { alternatives: [{ transcript: "I want a" }] } }));
        ws.send(JSON.stringify({ type: "Results", is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "haircut tomorrow" }] } }));
      }
    });
  });
  await new Promise((r) => fake.listen(0, r));
  const at = `127.0.0.1:${fake.address().port}`;
  Object.assign(ENDPOINTS, {
    deepgramListen: `ws://${at}/v1/listen`, deepgramSpeak: `http://${at}/v1/speak`,
    sarvamSpeak: `http://${at}/sarvam-tts`, elevenlabs: `http://${at}`,
  });
  const org = { voiceKeys: { deepgram: "dg-key", sarvam: "sv-key", elevenlabs: "el-key" }, voice: { customTtsUrl: `http://${at}/my-voice`, voices: { "ta-IN": "anushka" } } };
  try {
    // Ears
    const finals = [];
    let started = 0;
    const ears = openStt({ engine: "deepgram", org, language: "en-IN", onSpeechStart: () => started++, onFinal: (t) => finals.push(t) });
    for (let i = 0; i < 3; i++) ears.write(tone(20));
    await until(() => finals.length);
    ears.close();
    assert.deepEqual(finals, ["I want a haircut tomorrow"]);
    assert.equal(started, 1);
    assert.equal(heardAudio[0], 320, "20 ms of 16-bit audio per frame");
    const listen = fake.requests.find((r) => r.url.startsWith("/v1/listen"));
    assert.equal(listen.headers.authorization, "Token dg-key");
    assert.match(listen.url, /encoding=linear16&sample_rate=8000/);
    assert.match(listen.url, /language=en-IN/);

    // Mouths: all return 8 kHz audio of the right length
    const el = await synthesize({ engine: "elevenlabs", org, text: "Hello", language: "en-IN" });
    assert.equal(el.length, 2000);
    const elReq = fake.requests.find((r) => r.url.startsWith("/v1/text-to-speech/"));
    assert.match(elReq.url, /output_format=ulaw_8000/);
    assert.equal(elReq.headers["xi-api-key"], "el-key");

    const sv = await synthesize({ engine: "sarvam", org, text: "வணக்கம்", language: "ta-IN" });
    assert.ok(Math.abs(sv.length - 4000) <= 2, `sarvam ${sv.length}`);
    const svReq = fake.requests.find((r) => r.url === "/sarvam-tts");
    assert.deepEqual(JSON.parse(svReq.body), { text: "வணக்கம்", target_language_code: "ta-IN", speech_sample_rate: 8000, speaker: "anushka" });
    assert.equal(svReq.headers["api-subscription-key"], "sv-key");

    assert.equal((await synthesize({ engine: "deepgram", org, text: "Hi", language: "en-IN" })).length, 2400);
    const own = await synthesize({ engine: "custom", org, text: "Our own voice", language: "hi-IN" });
    assert.equal(own.length, 3200, "16 kHz WAV from your server is resampled to 8 kHz");
    assert.deepEqual(JSON.parse(fake.requests.find((r) => r.url === "/my-voice").body), { text: "Our own voice", language: "hi-IN", voice: "", sample_rate: 8000, format: "wav" });
  } finally {
    fake.close();
  }
});

// ---------------- Phone companies ----------------
process.env.VOICE_ENGINE = "mock";

async function addNumber(token, agent, carrier, number) {
  const res = await api(token, "POST", "/phone-voice/numbers", { number, carrier, agentId: agent.id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const sessionFor = (callId) => until(() => liveSessions.get(callId));

for (const [carrier, startMsg, mediaIn, expectOut] of [
  ["twilio",
    { event: "start", streamSid: "MZ1", start: { streamSid: "MZ1", callSid: "CA-in-1" } },
    (pcm) => ({ event: "media", streamSid: "MZ1", media: { track: "inbound", payload: encodeMulaw(pcm).toString("base64") } }),
    { media: (m) => m.event === "media" && m.streamSid === "MZ1" && m.media.payload, clear: (m) => m.event === "clear" && m.streamSid === "MZ1", mark: (m) => m.event === "mark" }],
  ["plivo",
    { event: "start", start: { streamId: "st-1", callId: "pl-call-1" } },
    (pcm) => ({ event: "media", media: { payload: encodeMulaw(pcm).toString("base64") } }),
    { media: (m) => m.event === "playAudio" && m.media.contentType === "audio/x-mulaw" && m.media.sampleRate === 8000, clear: (m) => m.event === "clearAudio" && m.streamId === "st-1", mark: (m) => m.event === "checkpoint" }],
  ["vobiz",
    { event: "start", start: { streamId: "vb-1", callId: "vb-call-1" } },
    (pcm) => ({ event: "media", media: { payload: encodeMulaw(pcm).toString("base64") } }),
    { media: (m) => m.event === "playAudio", clear: (m) => m.event === "clearAudio" && m.streamId === "vb-1", mark: (m) => m.event === "checkpoint" }],
]) {
  test(`${carrier}: incoming call → answer XML → live stream → own voice replies, barge-in clears audio`, async () => {
    const { token, agent } = await business();
    const num = await addNumber(token, agent, carrier, `+91804000${String(n).padStart(4, "0")}`);
    assert.ok(num.answerUrl.startsWith(`${base}/voice/${carrier}/answer/${num.id}/`));

    // Wrong token: refused.
    assert.equal((await fetch(num.answerUrl.replace(/[\w-]+$/, "nope"), { method: "POST" })).status, 404);

    const form = carrier === "twilio" ? { CallSid: "CA-in-1", From: "+919811111111", To: num.number } : { CallUUID: `${carrier}-call-1`, From: "919811111111", To: num.number.slice(1) };
    const xml = await (await fetch(num.answerUrl, { method: "POST", body: new URLSearchParams(form) })).text();
    const url = /(ws:\/\/[^<"]+)/.exec(xml)[1];
    if (carrier === "twilio") assert.match(xml, /<Connect><Stream url="ws:\/\/127\.0\.0\.1:\d+\/stream\/twilio\//);
    else assert.match(xml, /<Stream bidirectional="true" keepCallAlive="true" contentType="audio\/x-mulaw;rate=8000">ws:\/\//);

    const callId = url.split("/").at(-2);
    const call = db.get("calls", callId);
    assert.equal(call.carrier, carrier);
    assert.equal(call.callerNumber, "+919811111111");

    const line = await phoneLine(url);
    line.send(startMsg);
    const session = await sessionFor(callId);
    // Greeting is spoken in our own voice (the offline test voice here).
    await until(() => line.got.some(expectOut.media));
    assert.ok(line.got.some(expectOut.mark), "marks track playback");
    // Caller audio reaches the ears.
    line.send(mediaIn(tone(20)));
    await until(() => session.ears.frames >= 1);

    // Caller talks over the greeting: barge-in clears what wasn't played.
    session.ears.say("How much is a haircut?");
    await until(() => line.got.some(expectOut.clear));
    await until(() => db.get("calls", callId).transcript.some((t) => t.role === "agent" && /450/.test(t.text)));
    assert.ok(mockTtsLog.some((s) => /450/.test(s.text)), "reply spoken by the voice engine");
    assert.equal(db.get("calls", callId).interruptions, 1);

    // Caller hangs up.
    line.ws.close();
    await until(() => db.get("calls", callId).status === "ended");
    assert.equal(db.get("calls", callId).outcome, "caller-hung-up");
  });
}

test("exotel: Voicebot stream per number, 16-bit PCM both ways, call created from the start event", async () => {
  const { token, agent } = await business();
  const num = await addNumber(token, agent, "exotel", "+918047112233");
  assert.match(num.streamUrl, /^ws:\/\/127\.0\.0\.1:\d+\/stream\/exotel\/number\//);
  assert.equal(num.answerUrl, undefined);

  const line = await phoneLine(num.streamUrl);
  line.send({ event: "connected" });
  line.send({ event: "start", stream_sid: "EXS1", start: { stream_sid: "EXS1", call_sid: "exo-call-9", from: "09811122233", to: "08047112233" } });
  const call = await until(() => db.find("calls", (c) => c.providerCallId === "exo-call-9")[0]);
  assert.equal(call.carrier, "exotel");
  assert.equal(call.numberId, num.id);
  const out = await until(() => line.got.find((m) => m.event === "media"));
  assert.equal(out.stream_sid, "EXS1");
  assert.equal(Buffer.from(out.media.payload, "base64").length % 320, 0, "320-byte multiples");
  const session = await sessionFor(call.id);
  line.send({ event: "media", stream_sid: "EXS1", media: { payload: pcmToBytes(tone(40)).toString("base64") } });
  await until(() => session.ears.frames >= 1);
  session.ears.say("What time do you open?");
  await until(() => db.get("calls", call.id).transcript.filter((t) => t.role === "agent").length >= 2);
  line.send({ event: "stop" });
  await until(() => db.get("calls", call.id).status === "ended");
});

test("transfer to a person: Plivo transfer API with a Dial XML for the team", async () => {
  const { token, org, agent } = await business();
  await api(token, "PUT", "/phone-voice/carriers/plivo", { authId: "MAPLIVO", authToken: "secret-plivo-token" });
  const num = await addNumber(token, agent, "plivo", "+918040990011");
  const xml = await (await fetch(num.answerUrl, { method: "POST", body: new URLSearchParams({ CallUUID: "plv-transfer", From: "919822222222", To: "918040990011" }) })).text();
  const url = /(ws:\/\/[^<"]+)/.exec(xml)[1];
  const callId = url.split("/").at(-2);
  const line = await phoneLine(url);
  line.send({ event: "start", start: { streamId: "s-t", callId: "plv-transfer" } });
  const session = await sessionFor(callId);
  rest.length = 0;
  session.ears.say("I want to talk to a real person please");
  const req = await until(() => rest.find((r) => r.url.endsWith("/Call/plv-transfer/")), 5000);
  assert.equal(req.url, "https://api.plivo.com/v1/Account/MAPLIVO/Call/plv-transfer/");
  const body = JSON.parse(req.init.body);
  assert.equal(body.legs, "aleg");
  const dial = await (await fetch(body.aleg_url, { method: "POST" })).text();
  assert.match(dial, /<Dial callerId="918040990011"><Number>91\d+<\/Number><\/Dial>/);
  assert.match(dial, new RegExp((agent.transferNumber || org.ownerPhone || db.get("orgs", org.id).ownerPhone).replace("+", "")));
  await until(() => db.get("calls", callId).status === "ended");
  assert.equal(db.get("calls", callId).outcome, "transferred");
  line.ws.close();
});

test("outbound: AI calls go out through the business's own phone company and number", async () => {
  const { token, org, agent } = await business();
  // No number yet: the platform's Twilio account (older path).
  const c0 = startCall(db, db.get("agents", agent.id), { channel: "phone", direction: "outbound", callerNumber: "+919800000001" });
  assert.equal((await placeCall(db, { call: c0, to: "+919800000001" })).ok, true);
  assert.match(legacy.at(-1).url, /\/twilio\/outbound\//);

  for (const [carrier, creds, number, check] of [
    ["plivo", { authId: "MAP1", authToken: "tokp" }, "+918041000001", (r) => {
      assert.equal(r.url, "https://api.plivo.com/v1/Account/MAP1/Call/");
      assert.equal(r.init.headers.authorization, `Basic ${Buffer.from("MAP1:tokp").toString("base64")}`);
      const b = JSON.parse(r.init.body);
      assert.equal(b.from, "918041000001");
      assert.match(b.answer_url, /\/voice\/plivo\/outbound\//);
      assert.match(b.hangup_url, /\/voice\/plivo\/status\//);
    }],
    ["vobiz", { authId: "VB1", authToken: "tokv" }, "+918041000002", (r) => {
      assert.equal(r.url, "https://api.vobiz.ai/api/v1/Account/VB1/Call/");
      assert.equal(r.init.headers["X-Auth-ID"], "VB1");
      assert.equal(r.init.headers["X-Auth-Token"], "tokv");
    }],
    ["exotel", { accountSid: "exo1", apiKey: "key1", apiToken: "tok1", subdomain: "api.in.exotel.com", flowId: "777" }, "+918041000003", (r) => {
      assert.equal(r.url, "https://api.in.exotel.com/v1/Accounts/exo1/Calls/connect.json");
      const b = new URLSearchParams(r.init.body);
      assert.equal(b.get("CallerId"), "+918041000003");
      assert.equal(b.get("Url"), "http://my.exotel.com/exo1/exoml/start_voice/777");
      assert.ok(b.get("CustomField"));
    }],
    ["twilio", { accountSid: "ACx", authToken: "tokt" }, "+918041000004", (r) => {
      assert.equal(r.url, "https://api.twilio.com/2010-04-01/Accounts/ACx/Calls.json");
      assert.match(new URLSearchParams(r.init.body).get("Url"), /\/voice\/twilio\/outbound\//);
    }],
  ]) {
    for (const old of db.find("numbers", (x) => x.orgId === org.id)) db.remove("numbers", old.id);
    assert.equal((await api(token, "PUT", `/phone-voice/carriers/${carrier}`, creds)).status, 200);
    await addNumber(token, agent, carrier, number);
    const call = startCall(db, db.get("agents", agent.id), { channel: "phone", direction: "outbound", callerNumber: "+919800000002" });
    rest.length = 0;
    const placed = await placeCall(db, { call, to: "+919800000002" });
    assert.equal(placed.ok, true, placed.error);
    check(rest[0]);
    const saved = db.get("calls", call.id);
    assert.equal(saved.carrier, carrier);
    assert.ok(saved.providerCallId);
    // Nobody answered: the status callback closes the call so retries happen.
    if (carrier !== "exotel") {
      const statusUrl = carrier === "twilio" ? new URLSearchParams(rest[0].init.body).get("StatusCallback") : JSON.parse(rest[0].init.body).hangup_url;
      assert.equal((await fetch(statusUrl, { method: "POST", body: new URLSearchParams(carrier === "twilio" ? { CallStatus: "no-answer" } : { HangupCause: "NO_ANSWER", Duration: "0" }) })).status, 204);
      assert.equal(db.get("calls", call.id).outcome, "no-answer");
    }
  }
});

test("settings: secrets never come back to the browser; numbers validated", async () => {
  const { token } = await business();
  await api(token, "PUT", "/phone-voice/carriers/exotel", { accountSid: "exoSID", apiKey: "k", apiToken: "very-secret-token-1234", subdomain: "api.exotel.com", flowId: "1" });
  await api(token, "PUT", "/phone-voice/engines", { stt: "sarvam", tts: "custom", customTtsUrl: "https://voice.mybusiness.in/tts", keys: { sarvam: "sarvam-secret-9876", custom: "bearer-abcd" }, voices: { "ta-IN": "anushka" } });
  const view = (await api(token, "GET", "/phone-voice")).body;
  const text = JSON.stringify(view);
  for (const secret of ["very-secret-token-1234", "sarvam-secret-9876", "bearer-abcd"]) assert.ok(!text.includes(secret), secret);
  const exo = view.carriers.find((c) => c.id === "exotel");
  assert.equal(exo.ready, true);
  assert.equal(exo.fields.find((f) => f.name === "apiToken").last4, "…1234");
  assert.equal(exo.fields.find((f) => f.name === "accountSid").value, "exoSID", "non-secret fields are shown back");
  assert.equal(view.engines.keys.sarvam.last4, "…9876");
  assert.equal(view.engines.tts, "custom");
  const me = JSON.stringify((await api(token, "GET", "/me")).body);
  assert.ok(!me.includes("very-secret") && !me.includes("sarvam-secret"));
  // Saving again with an empty secret keeps the old one.
  await api(token, "PUT", "/phone-voice/carriers/exotel", { apiToken: "", flowId: "2" });
  assert.equal((await api(token, "GET", "/phone-voice")).body.carriers.find((c) => c.id === "exotel").ready, true);
  assert.equal((await api(token, "POST", "/phone-voice/numbers", { number: "12", carrier: "plivo" })).status, 400);
  assert.equal((await api(token, "POST", "/phone-voice/numbers", { number: "+918040000000", carrier: "nokia" })).status, 400);
  assert.equal((await api(token, "PUT", "/phone-voice/engines", { customTtsUrl: "http://evil.example/tts" })).status, 400);
  assert.equal((await api(token, "PUT", "/phone-voice/carriers/exotel", { subdomain: "evil.example.com" })).status, 400);
});

test("voice preview returns a playable WAV; test calls only ring your own phone", async () => {
  const { token, agent } = await business();
  const wav = await api(token, "POST", "/phone-voice/preview", { language: "hi-IN" });
  assert.equal(wav.status, 200);
  assert.equal(wav.type, "audio/wav");
  assert.ok(parseWav(wav.body).pcm.length > 0);
  assert.equal((await api(token, "POST", "/phone-voice/test-call", { agentId: agent.id, to: "+919999999999" })).status, 400);
  const ok = await api(token, "POST", "/phone-voice/test-call", { agentId: agent.id });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test("browser test call: the visitor's browser listens and speaks when no voice keys are set", async () => {
  const { token, agent } = await business();
  delete process.env.VOICE_ENGINE;
  try {
    const started = await api(token, "POST", "/phone-voice/web-call", { agentId: agent.id });
    assert.equal(started.status, 201);
    assert.deepEqual(started.body.engines, { stt: "browser", tts: "browser" });
    const line = await phoneLine(base.replace("http", "ws") + started.body.url);
    line.send({ event: "start" });
    const greet = await until(() => line.got.find((m) => m.event === "say"));
    assert.match(greet.text, /Voice \d+|thank|hello|welcome/i);
    line.send({ event: "text", text: "Do you do facials?" });
    await until(() => line.got.filter((m) => m.event === "say").length >= 2);
    line.send({ event: "stop" });
    await until(() => db.get("calls", started.body.callId).status === "ended");
  } finally {
    process.env.VOICE_ENGINE = "mock";
  }
});

test("calls are refused politely when the voice engine isn't set up", async () => {
  const { token, org, agent } = await business();
  const num = await addNumber(token, agent, "plivo", "+918040555666");
  delete process.env.VOICE_ENGINE;
  try {
    const xml = await (await fetch(num.answerUrl, { method: "POST", body: new URLSearchParams({ CallUUID: "x", From: "919800000009" }) })).text();
    assert.match(xml, /<Dial callerId="918040555666"><Number>/, "passed to the team instead of silence");
    assert.ok(db.find("alerts", (a) => a.orgId === org.id && /can't be answered/.test(a.title)).length);
  } finally {
    process.env.VOICE_ENGINE = "mock";
  }
});
