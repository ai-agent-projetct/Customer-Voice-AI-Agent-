// VoiceDesk Voice API: programmable calls on our own network (like Twilio /
// Plivo voice APIs). A SipUA plays the phone network; a local HTTP server
// plays the developer's app (answer_url, gather action, status callback).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/db.js";
import { createApp } from "../server/index.js";
import { transport } from "../server/messaging.js";
import { SipUA } from "../server/sip/ua.js";
import { startSipGateway, stopSipGateway } from "../server/sip/gateway.js";
import { liveSessions } from "../server/voice/router.js";
import { parseWav, tone } from "../server/voice/audio.js";
import { mockTtsLog } from "../server/voice/engines.js";

delete process.env.ANTHROPIC_API_KEY;
process.env.VOICE_ENGINE = "mock";
process.env.VOICE_SILENCE_MS = "60000";
process.env.VOICE_ALLOW_LOCAL_URLS = "1";
process.env.SIGNUP_RATE_LIMIT = "1000";
process.env.RECORDINGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vd-rec-"));
transport.send = async () => ({ status: "sent" });

const db = new Store(null);
let server, base, gateway, phone, appServer, appBase, key, org, agent, number;
const hooks = []; // what the developer's app received
let routes = {}; // path → (body) => response JSON

const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};
const api = async (method, p, body) => {
  const res = await fetch(`${base}/api/v1/voice${p}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: body && JSON.stringify(body) });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()), type };
};
/** Press a key on a phone leg (RFC 4733 event, end bit set). */
const press = (leg, digit) => {
  const code = "0123456789*#".indexOf(digit);
  const pkt = Buffer.from([0x80, 101, 0, 9, 0, 0, Math.floor(Math.random() * 255), 0, 0, 0, 0, 7, code, 0x80, 0, 160]);
  leg.rtp.socket.send(pkt, leg.rtp.remote.port, leg.rtp.remote.address);
};

before(async () => {
  server = createApp(db).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const signup = await (await fetch(`${base}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ businessName: "Glow Salon", name: "Owner", email: "api@x.in", password: "password123" }) })).json();
  org = db.update("orgs", signup.org.id, { plan: "business", ownerPhone: "+919845000001" });
  agent = await (await fetch(`${base}/api/agents`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${signup.token}` }, body: JSON.stringify({ templateId: "salon" }) })).json();
  key = (await (await fetch(`${base}/api/developer/api-keys`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${signup.token}` }, body: "{}" })).json()).key;
  number = db.insert("numbers", { orgId: org.id, number: "+918047000001", carrier: "voicedesk", agentId: agent.id, outbound: true, token: "t" });

  appServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : {};
      hooks.push({ path: req.url, body: json });
      const answer = routes[req.url]?.(json);
      res.setHeader("content-type", "application/json");
      res.end(answer === undefined ? "" : JSON.stringify(answer));
    });
  });
  await new Promise((r) => appServer.listen(0, "127.0.0.1", r));
  appBase = `http://127.0.0.1:${appServer.address().port}`;

  phone = await new SipUA({ port: 0, host: "127.0.0.1", rtp: { min: 46000, max: 46998 } }).start();
  phone.answered = [];
  phone.on("invite", async (leg) => { leg.ringing(); await leg.answer(); phone.answered.push(leg); });
  gateway = await startSipGateway(db, {
    port: 0, host: "127.0.0.1", publicIp: "127.0.0.1", rtp: { min: 47000, max: 47998 },
    trunk: { host: "127.0.0.1", port: phone.port, domain: "127.0.0.1" }, allowedIps: ["127.0.0.1"],
  });
});
after(() => {
  phone.stop();
  stopSipGateway();
  appServer.close();
  server.closeAllConnections?.();
  server.close();
});

test("outbound call flow: message, keypad menu, connect to a person, recording, billing, status callback", async () => {
  routes["/status"] = () => ({ ok: true });
  const placed = await api("POST", "/calls", {
    to: "+919811000001",
    record: true,
    status_callback: `${appBase}/status`,
    flow: [
      { say: "Your order 1042 is ready for pickup." },
      { gather: { numDigits: 1, timeout: 5, prompt: [{ say: "Press 1 to talk to the shop, or 2 to end." }],
          options: { "1": [{ say: "Connecting you now." }, { dial: { number: "+919845000001" } }], "2": [{ say: "Goodbye." }] } } },
      { say: "Thank you for calling." },
      { hangup: true },
    ],
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  assert.equal(placed.body.status, "ringing");
  const customer = await until(() => phone.answered.find((l) => l.toUser === "+919811000001"));
  assert.equal(customer.fromUser, "+918047000001", "caller ID is your VoiceDesk number");
  await until(() => mockTtsLog.some((s) => /Press 1/.test(s.text)));
  press(customer, "1");
  const shop = await until(() => phone.answered.find((l) => l.toUser === "+919845000001"), 8000);
  // Customer ↔ shop audio flows through VoiceDesk.
  let reached = 0;
  shop.rtp.onAudio = (pcm) => { if (pcm.some((s) => Math.abs(s) > 1000)) reached++; };
  customer.rtp.play(tone(600));
  await until(() => reached > 5);
  await new Promise((r) => setTimeout(r, 1100)); // a second or so of talk: billed as 1 minute (rounded up)
  await shop.bye(); // the shop hangs up: the flow continues
  await until(() => mockTtsLog.some((s) => /Thank you for calling/.test(s.text)));
  await until(() => customer.state === "ended");
  const status = await until(() => hooks.find((h) => h.path === "/status"));
  const c = status.body.call;
  assert.equal(c.status, "completed");
  assert.equal(c.outcome, "completed");
  assert.equal(c.direction, "outbound");
  assert.equal(c.billed_minutes, 1);
  assert.equal(c.cost_inr, 0.6);
  assert.ok(c.recording && c.recording.seconds >= 1);
  assert.ok(c.events.some((e) => e.step === "dial" && e.outcome === "completed"));
  const got = await api("GET", `/calls/${placed.body.id}`);
  assert.equal(got.body.recording.id, c.recording.id);
  const wav = await api("GET", `/recordings/${c.recording.id}`);
  assert.equal(wav.type, "audio/wav");
  assert.ok(parseWav(wav.body).pcm.length > 8000);
  const usage = await api("GET", "/usage");
  assert.equal(usage.body.outbound.minutes, 1);
  assert.equal(usage.body.outbound.cost_inr, 0.6);
});

test("incoming calls to your voice_url: voicemail recorded and sent to your app", async () => {
  routes["/answer"] = () => [{ say: "Please leave a message after the tone." }, { record: { maxSeconds: 2, finishOnKey: "#", action: `${appBase}/recorded` } }];
  routes["/recorded"] = () => ({ flow: [{ say: "Thanks, we got it." }, { hangup: true }] });
  const patched = await api("PATCH", `/numbers/${number.id}`, { voice_url: `${appBase}/answer` });
  assert.equal(patched.body.handled_by, "your voice_url");
  const leg = await phone.invite({ to: "+918047000001", from: "+919822000002", dest: { address: "127.0.0.1", port: gateway.port }, domain: "127.0.0.1" });
  const answer = await until(() => hooks.find((h) => h.path === "/answer"));
  assert.equal(answer.body.from, "+919822000002");
  assert.equal(answer.body.to, "+918047000001");
  assert.equal(answer.body.event, "call.answered");
  await until(() => mockTtsLog.some((s) => /leave a message/.test(s.text)));
  leg.rtp.play(tone(1500)); // the caller speaks
  await new Promise((r) => setTimeout(r, 400));
  press(leg, "#");
  const recorded = await until(() => hooks.find((h) => h.path === "/recorded"));
  assert.ok(recorded.body.recording_id);
  assert.equal(recorded.body.finished_by, "key");
  const message = db.get("recordings", recorded.body.recording_id);
  assert.equal(message.kind, "message");
  await until(() => leg.state === "ended");
  await api("PATCH", `/numbers/${number.id}`, { voice_url: null });
});

test("keypad digits go to your action URL, which can hand the call to the AI receptionist", async () => {
  routes["/menu"] = () => [{ gather: { numDigits: 2, timeout: 5, prompt: [{ say: "Enter your 2 digit code" }], action: `${appBase}/code` } }];
  routes["/code"] = (body) => (body.digits === "42" ? [{ say: "Thank you." }, { ai: {} }] : [{ say: "Wrong code." }, { hangup: true }]);
  await api("PATCH", `/numbers/${number.id}`, { voice_url: `${appBase}/menu` });
  const leg = await phone.invite({ to: "+918047000001", from: "+919822000003", dest: { address: "127.0.0.1", port: gateway.port }, domain: "127.0.0.1" });
  await until(() => mockTtsLog.some((s) => /2 digit code/.test(s.text)));
  press(leg, "4");
  await new Promise((r) => setTimeout(r, 120));
  press(leg, "2");
  const code = await until(() => hooks.find((h) => h.path === "/code"));
  assert.equal(code.body.digits, "42");
  const call = await until(() => db.find("calls", (c) => c.providerCallId === leg.callId && c.agentId === agent.id && c.channel === "phone")[0]);
  const session = await until(() => liveSessions.get(call.id));
  session.ears.say("How much is a facial?");
  await until(() => db.get("calls", call.id).transcript.some((t) => t.role === "agent" && /rupees/.test(t.text)));
  await leg.bye();
  await until(() => db.get("calls", call.id).status === "ended");
  await api("PATCH", `/numbers/${number.id}`, { voice_url: null });
});

test("API checks: bad flows, numbers that aren't yours, other businesses' calls, do-not-call", async () => {
  assert.equal((await api("POST", "/calls", { to: "+919811000001", flow: [{ dance: true }] })).status, 400);
  assert.equal((await api("POST", "/calls", { to: "+919811000001", from: "+918000000000", flow: [{ say: "hi" }] })).status, 400);
  assert.equal((await api("POST", "/calls", { to: "12", flow: [{ say: "hi" }] })).status, 400);
  assert.equal((await api("POST", "/calls", { to: "+919811000001" })).status, 400);
  process.env.VOICE_ALLOW_LOCAL_URLS = "0";
  assert.equal((await api("POST", "/calls", { to: "+919811000001", answer_url: "http://127.0.0.1:9/x" })).status, 400, "private URLs refused");
  process.env.VOICE_ALLOW_LOCAL_URLS = "1";
  db.insert("customers", { orgId: org.id, phone: "+919811000077", doNotCall: true, calls: 0 });
  assert.match((await api("POST", "/calls", { to: "+919811000077", flow: [{ say: "hi" }] })).body.error, /do-not-call/);
  const other = db.insert("calls", { orgId: "someone-else", status: "ended", transcript: [] });
  assert.equal((await api("GET", `/calls/${other.id}`)).status, 404);
  const bad = await fetch(`${base}/api/v1/voice/numbers`, { headers: { authorization: "Bearer vd_live_nope" } });
  assert.equal(bad.status, 401);
});
