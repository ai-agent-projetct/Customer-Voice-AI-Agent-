// Multilingual voice: language menu, live switching, script detection,
// remembered preferences, voices, speed, premium audio and campaigns.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/db.js";
import { createApp } from "../server/index.js";
import { provider } from "../server/tts.js";
import { dialer } from "../server/telephony.js";
import { tick } from "../server/scheduler.js";
import { detectLanguage, pickLanguage } from "../server/languages.js";
import { todayIn } from "../server/util.js";

delete process.env.ANTHROPIC_API_KEY;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.ELEVENLABS_API_KEY;
process.env.SIGNUP_RATE_LIMIT = "1000";

const db = new Store(null);
let server, base;

before(async () => {
  server = createApp(db).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function api(token, method, path, body) {
  const res = await fetch(base + "/api" + path, {
    method,
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const twilio = (path, params) => fetch(base + path, { method: "POST", body: new URLSearchParams(params) }).then((r) => r.text());
const callIdOf = (xml) => xml.match(/\/twilio\/(?:gather|language)\/([\w-]+)/)[1];

let n = 0;
async function business(settings = {}) {
  n++;
  const { body } = await api(null, "POST", "/auth/signup", { businessName: `Glow ${n}`, name: "Owner", email: `lang${n}@x.in`, password: "password123" });
  const agent = (await api(body.token, "POST", "/agents", { templateId: "salon" })).body;
  const phone = `+9180000100${String(n).padStart(2, "0")}`;
  const saved = await api(body.token, "PUT", `/agents/${agent.id}`, { phoneNumber: phone, ...settings });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return { token: body.token, org: body.org, agent: saved.body, phone };
}

test("multilingual callers choose a language from the menu, and it's remembered", async () => {
  const { phone } = await business({ languages: ["hi-IN", "ta-IN"] });
  const menu = await twilio("/twilio/voice", { To: phone, From: "+919811000001", CallSid: "LM1" });
  assert.match(menu, /<Gather input="dtmf speech" numDigits="1"/);
  assert.match(menu, /For English, press 1\./);
  assert.match(menu, /हिंदी के लिए 2 दबाइए।/);
  assert.match(menu, /voice="Google\.ta-IN-Standard-A" language="ta-IN">தமிழுக்கு 3 ஐ அழுத்தவும்\./);
  assert.match(menu, /<Redirect method="POST">\/twilio\/language\//);

  const callId = callIdOf(menu);
  const tamil = await twilio(`/twilio/language/${callId}`, { Digits: "3" });
  assert.match(tamil, /<Gather input="speech"[^>]*language="ta-IN"/);
  assert.match(tamil, /வணக்கம்! Glow \d+-ஐ அழைத்ததற்கு நன்றி/);
  assert.equal(db.get("calls", callId).language, "ta-IN");

  // Not hearing anything: the retry is in Tamil too.
  assert.match(await twilio(`/twilio/gather/${callId}`, { SpeechResult: "" }), /மன்னிக்கவும்/);

  // Calling again: no menu, straight into Tamil.
  const again = await twilio("/twilio/voice", { To: phone, From: "09811000001", CallSid: "LM2" });
  assert.doesNotMatch(again, /dtmf/);
  assert.match(again, /language="ta-IN"/);
});

test("callers can say the language name, or wait for the main language", async () => {
  const { agent, phone } = await business({ languages: ["hi-IN", "ta-IN"] });
  const id1 = callIdOf(await twilio("/twilio/voice", { To: phone, From: "+919811000011", CallSid: "LS1" }));
  assert.match(await twilio(`/twilio/language/${id1}`, { SpeechResult: "Hindi please" }), /नमस्ते!/);
  const id2 = callIdOf(await twilio("/twilio/voice", { To: phone, From: "+919811000012", CallSid: "LS2" }));
  assert.match(await twilio(`/twilio/language/${id2}`, {}), /<Gather input="speech"[^>]*language="en-IN"/);
  assert.equal(pickLanguage(db.get("agents", agent.id), { speech: "தமிழ்" }), "ta-IN");
});

test("callers can switch language mid-call, and the voice and listening follow", async () => {
  const { phone } = await business({ languages: ["hi-IN", "ta-IN"], languageMenu: false });
  const first = await twilio("/twilio/voice", { To: phone, From: "+919811000021", CallSid: "SW1" });
  assert.match(first, /language="en-IN"/);
  const callId = callIdOf(first);
  const switched = await twilio(`/twilio/gather/${callId}`, { SpeechResult: "Can you speak Tamil?" });
  assert.match(switched, /<Gather input="speech"[^>]*language="ta-IN"/);
  assert.match(switched, /voice="Google\.ta-IN-Standard-A"/);
  assert.match(switched, /சரி, இனி தமிழில் பேசலாம்/);
  const log = db.get("calls", callId).languageLog.map((l) => `${l.code}:${l.reason}`);
  assert.deepEqual(log, ["en-IN:start", "ta-IN:tool"]);
  const customer = db.find("customers", (c) => c.phone === "+919811000021")[0];
  assert.equal(customer.preferredLanguage, "ta-IN");
});

test("writing in another script switches the website chat automatically", async () => {
  const { token, agent } = await business({ languages: ["ta-IN", "hi-IN"], widgetEnabled: true });
  const pub = (await api(token, "GET", `/agents/${agent.id}`)).body.publicId;
  const info = await api(null, "GET", `/public/agents/${pub}`);
  assert.deepEqual(info.body.languages.map((l) => l.native), ["English", "தமிழ்", "हिन्दी"]);

  const hindiChat = await api(null, "POST", `/public/agents/${pub}/sessions`, { language: "hi-IN" });
  assert.match(hindiChat.body.greeting, /नमस्ते! मैं Glow \d+ की AI सहायक हूँ/);

  const s = await api(null, "POST", `/public/agents/${pub}/sessions`, {});
  assert.equal(s.body.language, "en-IN");
  const r = await api(null, "POST", `/public/sessions/${s.body.sessionId}/say`, { secret: s.body.secret, text: "நாளை மாலை நேரம் கிடைக்குமா" });
  assert.equal(r.body.language, "ta-IN");
  assert.match(r.body.reply, /சரி, இனி தமிழில் பேசலாம்/);
  assert.equal(detectLanguage(db.get("agents", agent.id), "kal shaam slot hai kya", "en-IN"), null); // Hinglish in Latin script stays put
});

test("voice gender, speaking speed and validation", async () => {
  const { token, agent, phone } = await business({ language: "hi-IN", voiceGender: "male", speakingRate: "slow" });
  const xml = await twilio("/twilio/voice", { To: phone, From: "+919811000031", CallSid: "VG1" });
  assert.match(xml, /<Say voice="Google\.hi-IN-Neural2-B" language="hi-IN"><prosody rate="85%">नमस्ते!/);
  for (const bad of [{ languages: ["xx-YY"] }, { voiceGender: "robot" }, { speakingRate: "warp" }, { greetings: { "zz-ZZ": "hi" } }, { voices: { "hi-IN": "<bad>" } }]) {
    assert.equal((await api(token, "PUT", `/agents/${agent.id}`, bad)).status, 400, JSON.stringify(bad));
  }
  // An owner's own greeting and voice per language win over the defaults.
  await api(token, "PUT", `/agents/${agent.id}`, { languages: ["ta-IN"], greetings: { "ta-IN": "வணக்கம், Glow சலூன்!" }, voices: { "ta-IN": "Google.ta-IN-Standard-D" } });
  const id = callIdOf(await twilio("/twilio/voice", { To: phone, From: "+919811000032", CallSid: "VG2" }));
  const ta = await twilio(`/twilio/language/${id}`, { Digits: "2" });
  assert.match(ta, /voice="Google\.ta-IN-Standard-D"[^>]*><prosody rate="85%">வணக்கம், Glow சலூன்!/);
});

test("premium voices play generated audio, and fall back to standard voices on errors", async () => {
  process.env.ELEVENLABS_API_KEY = "test";
  process.env.PUBLIC_URL = "https://voicedesk.example";
  const original = provider.synthesize;
  try {
    const { phone } = await business({ voiceEngine: "premium" });
    let calls = 0;
    provider.synthesize = async ({ text }) => {
      calls++;
      return { audio: Buffer.from(`MP3:${text}`), type: "audio/mpeg" };
    };
    const xml = await twilio("/twilio/voice", { To: phone, From: "+919811000041", CallSid: "PV1" });
    const url = xml.match(/<Play>([^<]+)<\/Play>/)[1];
    assert.match(url, /^https:\/\/voicedesk\.example\/audio\/[a-f0-9]{32}\.mp3$/);
    const audio = await fetch(base + new URL(url).pathname);
    assert.equal(audio.headers.get("content-type"), "audio/mpeg");
    assert.match(await audio.text(), /^MP3:Hi! Thanks for calling/);
    await twilio("/twilio/voice", { To: phone, From: "+919811000042", CallSid: "PV2" });
    assert.equal(calls, 1); // same greeting served from cache

    provider.synthesize = async () => { throw new Error("down"); };
    const id = callIdOf(xml);
    assert.match(await twilio(`/twilio/gather/${id}`, { SpeechResult: "" }), /<Say voice=/);
    assert.equal((await fetch(`${base}/audio/${"0".repeat(32)}.mp3`)).status, 404);
  } finally {
    provider.synthesize = original;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.PUBLIC_URL;
  }
});

test("campaign calls open in the customer's language with the AI disclosure", async () => {
  const { token, org, agent } = await business({ languages: ["hi-IN", "ta-IN"] });
  db.insert("customers", { orgId: org.id, phone: "+919811000052", name: "Kavya", calls: 1, preferredLanguage: "ta-IN" });
  const c = await api(token, "POST", "/campaigns", {
    agentId: agent.id, name: "Offer", goal: "Offer 10% off", openingLine: "…", language: "hi-IN", consentConfirmed: true,
    contacts: "Meena, 9811000051\nKavya, 9811000052",
  });
  assert.equal(c.body.language, "hi-IN");
  const placed = [];
  dialer.call = async (args) => { placed.push(args); return { ok: true, sid: `CAL${placed.length}` }; };
  await api(token, "POST", `/campaigns/${c.body.id}/start`);
  let morning = new Date(`${todayIn("Asia/Kolkata")}T05:30:00Z`);
  while (morning.getUTCDay() === 0) morning = new Date(morning.getTime() + 864e5);
  await tick(db, morning);
  const [meena, kavya] = (await api(token, "GET", `/campaigns/${c.body.id}`)).body.contacts;
  assert.match(db.get("calls", meena.callId).greeting, /^नमस्ते Meena, मैं Glow \d+ की ओर से AI सहायक बोल रही हूँ।/);
  assert.match(db.get("calls", kavya.callId).greeting, /^வணக்கம் Kavya, நான் Glow \d+ சார்பாக அழைக்கும் AI உதவியாளர்\./);
});

test("greetings can be translated for every language (demo: built-in greetings)", async () => {
  const { token, agent } = await business({ languages: ["bn-IN", "gu-IN"] });
  const res = await api(token, "POST", `/agents/${agent.id}/translate-greetings`, {});
  assert.deepEqual(Object.keys(res.body.greetings).sort(), ["bn-IN", "gu-IN"]);
  assert.match(res.body.greetings["bn-IN"], /^নমস্কার!/);
  const ins = await api(token, "GET", "/insights");
  assert.equal(typeof ins.body.languages, "object");
});
