// Real-time voice, developer API, webhooks, speed-to-lead, quality scores,
// callbacks, campaign retries, teams, click-to-call, recording, WhatsApp, orders.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { Store } from "../server/db.js";
import { createApp } from "../server/index.js";
import { attachRealtime } from "../server/realtime.js";
import { dialer } from "../server/telephony.js";
import { transport } from "../server/messaging.js";
import { tick } from "../server/scheduler.js";
import { runTool } from "../server/tools.js";
import { sign, webhookUrlProblem } from "../server/webhooks.js";
import { addDays, todayIn } from "../server/util.js";

delete process.env.ANTHROPIC_API_KEY;
delete process.env.TWILIO_AUTH_TOKEN;
process.env.SIGNUP_RATE_LIMIT = "1000";

const db = new Store(null);
let server, base, port, hookServer, hookUrl;
const hooks = [];
const placed = [];
transport.send = async () => ({ status: "sent" });
dialer.call = async (args) => {
  placed.push(args);
  return { ok: true, sid: `CAP${placed.length}` };
};

before(async () => {
  server = createApp(db).listen(0);
  attachRealtime(server, db);
  await new Promise((r) => server.once("listening", r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  hookServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hooks.push({ headers: req.headers, body });
      res.statusCode = req.url === "/fail" ? 500 : 200;
      res.end("ok");
    });
  }).listen(0);
  await new Promise((r) => hookServer.once("listening", r));
  hookUrl = `http://127.0.0.1:${hookServer.address().port}`;
});
after(() => {
  server.close();
  hookServer.close();
});

async function api(token, method, path, body) {
  const res = await fetch(base + "/api" + path, {
    method,
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const twilio = (path, params) => fetch(base + path, { method: "POST", body: new URLSearchParams(params) }).then((r) => r.text());
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};
// A time inside calling hours (11:00 India time) on a weekday.
const morning = () => {
  let d = new Date(`${todayIn("Asia/Kolkata")}T05:30:00Z`);
  while (d.getUTCDay() === 0) d = new Date(d.getTime() + 864e5);
  return d;
};

let n = 0;
async function business(settings = {}, org = {}) {
  n++;
  const { body } = await api(null, "POST", "/auth/signup", { businessName: `Shop ${n}`, name: "Owner", email: `plat${n}@x.in`, password: "password123" });
  if (Object.keys(org).length) await api(body.token, "PUT", "/settings", org);
  const agent = (await api(body.token, "POST", "/agents", { templateId: "salon" })).body;
  const phone = `+9180000200${String(n).padStart(2, "0")}`;
  const saved = await api(body.token, "PUT", `/agents/${agent.id}`, { phoneNumber: phone, ...settings });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return { token: body.token, org: body.org, agent: saved.body, phone };
}

test("real-time voice: streams the reply over the socket, switches language, and hands off transfers", async () => {
  process.env.PUBLIC_URL = `http://127.0.0.1:${port}`;
  try {
    const { phone } = await business({ voiceMode: "realtime", languages: ["ta-IN"], languageMenu: false, recordCalls: true }, { ownerPhone: "+919700000001" });
    const xml = await twilio("/twilio/voice", { To: phone, From: "+919811200001", CallSid: "RT1" });
    assert.match(xml, /<Start><Recording recordingStatusCallback="\/twilio\/recording\/[\w-]+"/);
    assert.match(xml, /<Connect action="\/twilio\/relay-done\/[\w-]+"><ConversationRelay url="ws:\/\/127\.0\.0\.1:\d+\/realtime\//);
    assert.match(xml, /<Language code="ta-IN" ttsProvider="Google" voice="ta-IN-Standard-A"/);
    const url = xml.match(/ConversationRelay url="([^"]+)"/)[1];
    const callId = url.split("/").at(-2);

    // A wrong token is refused.
    await new Promise((resolve) => new WebSocket(url.replace(/[\w-]+$/, "wrongtoken")).on("error", resolve));

    const ws = new WebSocket(url);
    const got = [];
    ws.on("message", (m) => got.push(JSON.parse(m)));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "setup", callSid: "RT1" }));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "How much is a facial?", last: true }));
    const first = await waitFor(() => got.find((m) => m.type === "text" && m.last));
    assert.match(first.token, /Facial is 800 rupees/);

    ws.send(JSON.stringify({ type: "interrupt", utteranceUntilInterrupt: "Facial is" }));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Can you speak Tamil?", last: true }));
    const langMsg = await waitFor(() => got.find((m) => m.type === "language"));
    assert.deepEqual([langMsg.ttsLanguage, langMsg.transcriptionLanguage], ["ta-IN", "ta-IN"]);
    assert.equal(db.get("calls", callId).interruptions, 1);

    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "I want to talk to the manager", last: true }));
    const end = await waitFor(() => got.find((m) => m.type === "end"));
    assert.deepEqual(JSON.parse(end.handoffData), { transfer: "+919700000001", outcome: "transferred" });
    ws.close();
    const done = await twilio(`/twilio/relay-done/${callId}`, { HandoffData: end.handoffData });
    assert.match(done, /<Dial>\+919700000001<\/Dial>/);
    assert.equal(db.get("calls", callId).outcome, "transferred");

    await twilio(`/twilio/recording/${callId}`, { RecordingUrl: "https://api.twilio.com/rec/RE1", RecordingDuration: "42" });
    assert.equal(db.get("calls", callId).recordingUrl, "https://api.twilio.com/rec/RE1.mp3");
  } finally {
    delete process.env.PUBLIC_URL;
  }
});

test("developer API keys, signed webhooks with retries, and safe webhook URLs", async () => {
  assert.match(webhookUrlProblem("http://example.com/x"), /https/);
  assert.match(webhookUrlProblem("https://127.0.0.1/x"), /public domain/);
  assert.match(webhookUrlProblem("https://localhost/x"), /public domain/);
  assert.equal(webhookUrlProblem("https://hooks.example.com/x"), null);

  process.env.ALLOW_LOCAL_WEBHOOKS = "1";
  const { token, agent } = await business();
  const created = await api(token, "POST", "/developer/api-keys", { name: "CRM" });
  const key = created.body.key;
  assert.match(key, /^vd_live_/);
  assert.equal((await api(token, "GET", "/developer/api-keys")).body[0].key, undefined); // never shown again
  assert.equal((await api("vd_live_wrong", "GET", "/v1/calls")).status, 401);
  assert.equal((await api(key, "GET", "/v1/calls")).status, 200);

  const hook = (await api(token, "POST", "/developer/webhooks", { url: `${hookUrl}/ok`, events: ["appointment.booked", "call.completed"] })).body;
  const failing = (await api(token, "POST", "/developer/webhooks", { url: `${hookUrl}/fail`, events: ["appointment.booked"] })).body;

  let d = addDays(todayIn("Asia/Kolkata"), 1);
  while (new Date(`${d}T12:00:00Z`).getUTCDay() === 0) d = addDays(d, 1);
  const before = hooks.length;
  runTool(db, db.get("agents", agent.id), { id: "wh1", channel: "phone", callerNumber: "+919811200002" }, "book_appointment", { customer_name: "Ravi", phone: "+919811200002", date: d, time: "10:00", service: "Haircut", notes: "" });
  const delivered = await waitFor(() => hooks.slice(before).find((h) => h.headers["x-voicedesk-event"] === "appointment.booked" && JSON.parse(h.body).data.customerName === "Ravi"));
  const ts = delivered.headers["x-voicedesk-timestamp"];
  assert.equal(delivered.headers["x-voicedesk-signature"], sign(hook.secret, ts, delivered.body));
  const failed = await waitFor(() => db.find("deliveries", (x) => x.webhookId === failing.id && x.status === "retrying")[0]);
  assert.match(failed.error, /HTTP 500/);
  delete process.env.ALLOW_LOCAL_WEBHOOKS;
});

test("speed to lead: a lead posted to the API gets an AI call at once, with consent and calling hours enforced", async () => {
  const { token, org } = await business({ languages: ["hi-IN"] });
  const key = (await api(token, "POST", "/developer/api-keys", {})).body.key;
  assert.equal((await api(key, "POST", "/v1/leads", { name: "Neha", phone: "98112 00003", interest: "Bridal package", call_now: true })).status, 400); // no consent

  const res = await api(key, "POST", "/v1/leads", { name: "Neha", phone: "98112 00003", interest: "Bridal package", source: "facebook", call_now: true, consent: true });
  assert.equal(res.status, 201);
  assert.equal(res.body.lead.source, "facebook");
  await tick(db, morning());
  const row = db.get("callbacks", res.body.call.id);
  assert.equal(row.status, "calling");
  const call = db.get("calls", row.callId);
  assert.match(call.greeting, /^Hello Neha, this is an AI assistant calling from Shop \d+\./);
  assert.match(call.goal, /just enquired about: Bridal package/);
  // Nobody answers: it is retried later, not dropped.
  await twilio("/twilio/status", { CallSid: call.twilioSid, CallStatus: "no-answer" });
  assert.equal(db.get("callbacks", row.id).status, "pending");
  assert.ok(db.get("callbacks", row.id).retryAt);

  // Do-not-call numbers are never dialled.
  db.insert("customers", { orgId: org.id, phone: "+919811200004", name: "", calls: 0, doNotCall: true });
  const blocked = await api(key, "POST", "/v1/calls", { phone: "+919811200004", goal: "Offer", consent: true });
  await tick(db, morning());
  assert.equal(db.get("callbacks", blocked.body.id).status, "skipped");
});

test("callbacks the caller asks for are scheduled and placed on time", async () => {
  const { token, agent } = await business();
  const a = db.get("agents", agent.id);
  const call = { id: "cb1", channel: "phone", callerNumber: "+919811200005", language: "en-IN" };
  const tomorrow = addDays(todayIn("Asia/Kolkata"), 1);
  assert.match(runTool(db, a, call, "schedule_callback", { phone: "", date: tomorrow, time: "22:30", reason: "Prices" }).result, /between 9am and 9pm/);
  assert.match(runTool(db, a, call, "schedule_callback", { phone: "", date: "2020-01-01", time: "10:00", reason: "Prices" }).result, /already passed/);
  assert.match(runTool(db, a, call, "schedule_callback", { phone: "", date: tomorrow, time: "11:30", reason: "Bridal prices" }).result, /Callback scheduled/);
  const [row] = (await api(token, "GET", "/callbacks")).body;
  assert.deepEqual([row.phone, row.time, row.status], ["+919811200005", "11:30", "pending"]);
  const dialled = () => placed.filter((p) => p.to === "+919811200005").length;
  await tick(db, new Date(`${tomorrow}T05:00:00Z`)); // 10:30 India: not yet
  assert.equal(dialled(), 0);
  await tick(db, new Date(`${tomorrow}T06:05:00Z`)); // 11:35 India
  assert.equal(dialled(), 1);
  assert.match(db.get("calls", db.get("callbacks", row.id).callId).goal, /calling back about: Bridal prices/);
});

test("campaign contacts who don't answer are retried", async () => {
  const { token, agent } = await business({}, {});
  db.update("orgs", db.get("agents", agent.id).orgId, { plan: "growth" });
  const c = (await api(token, "POST", "/campaigns", { agentId: agent.id, name: "Retry", goal: "Offer", openingLine: "Hi", contacts: "Asha, 9811200006", consentConfirmed: true, maxAttempts: 2, retryMinutes: 10 })).body;
  await api(token, "POST", `/campaigns/${c.id}/start`);
  await tick(db, morning());
  let contact = (await api(token, "GET", `/campaigns/${c.id}`)).body.contacts[0];
  await twilio("/twilio/status", { CallSid: db.get("calls", contact.callId).twilioSid, CallStatus: "busy" });
  contact = (await api(token, "GET", `/campaigns/${c.id}`)).body.contacts[0];
  assert.equal(contact.status, "pending");
  assert.match(contact.result, /busy: retry 1 of 1/);
  assert.equal((await api(token, "GET", `/campaigns/${c.id}`)).body.status, "running");
});

test("teams: the caller is transferred to the right department", async () => {
  const { phone } = await business({ departments: [{ name: "Billing", number: "98112 00010" }, { name: "Bridal", number: "+919811200011" }] });
  const a = db.find("agents", (x) => x.phoneNumber === phone)[0];
  const out = runTool(db, a, { id: "t1", channel: "phone" }, "transfer_to_human", { department: "Billing", reason: "Invoice" });
  assert.deepEqual([out.action.department, out.action.number], ["Billing", "+919811200010"]);
});

test("click-to-call rings the owner, then connects the customer", async () => {
  const { token } = await business();
  assert.equal((await api(token, "POST", "/click-to-call", { phone: "9811200012" })).status, 400); // no owner mobile yet
  await api(token, "PUT", "/settings", { ownerPhone: "+919700000002" });
  const res = await api(token, "POST", "/click-to-call", { phone: "98112 00012", name: "Meena" });
  assert.equal(res.status, 202);
  assert.equal(placed.at(-1).to, "+919700000002");
  const xml = await twilio(`/twilio/bridge/${res.body.callId}`, {});
  assert.match(xml, /Connecting you to Meena\.<\/Say><Dial>\+919811200012<\/Dial>/);
});

test("WhatsApp chat is answered by the same receptionist and remembers the conversation", async () => {
  const { token, phone } = await business({ whatsappEnabled: true });
  const send = (Body) => twilio("/twilio/whatsapp", { To: `whatsapp:${phone}`, From: "whatsapp:+919811200013", Body });
  assert.match(await send("How much is a haircut?"), /<Message>Haircut is 450 rupees/);
  assert.match(await send("I want to book a facial tomorrow at 11"), /<Message>/);
  const chats = (await api(token, "GET", "/calls")).body.filter((c) => c.channel === "whatsapp");
  assert.equal(chats.length, 1); // one conversation, not one per message
  assert.equal(chats[0].turns, 5);
  assert.equal(await twilio("/twilio/whatsapp", { To: "whatsapp:+910000000000", From: "whatsapp:+91981", Body: "hi" }), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

test("orders: items and totals are checked in code, and the owner is alerted", async () => {
  const { token, agent } = await business({ ordersEnabled: true });
  const a = db.get("agents", agent.id);
  const call = { id: "o1", channel: "phone", callerNumber: "+919811200014" };
  const order = (items, extra = {}) => runTool(db, a, call, "place_order", { customer_name: "Arjun", phone: "+919811200014", items, fulfilment: "pickup", address: "", notes: "", ...extra }).result;
  assert.match(order([{ name: "Pizza", quantity: 1 }]), /not on the list/);
  assert.match(order([{ name: "Facial", quantity: 1 }], { fulfilment: "delivery" }), /delivery address/);
  assert.match(order([{ name: "facial", quantity: 2 }, { name: "Haircut", quantity: 1 }]), /Total 2050 rupees/);
  const [saved] = (await api(token, "GET", "/orders")).body;
  assert.equal(saved.total, 2050);
  assert.equal((await api(token, "PATCH", `/orders/${saved.id}`, { status: "ready" })).body.status, "ready");
  assert.ok(db.find("alerts", (x) => x.kind === "order").length);
});

test("every call gets a quality score, shown on the quality report", async () => {
  const { token, agent } = await business();
  const { callId } = (await api(token, "POST", `/agents/${agent.id}/test`)).body;
  await api(token, "POST", `/calls/${callId}/say`, { text: "Do you do home visits?" });
  await api(token, "POST", `/calls/${callId}/end`);
  const q = await waitFor(async () => (await api(token, "GET", `/calls/${callId}`)).body.analysis?.quality);
  assert.ok(q.score > 0 && q.score <= 100);
  assert.match(q.issues[0], /Could not answer 1 question/);
  const report = (await api(token, "GET", "/quality")).body;
  assert.equal(report.calls, 1);
  assert.equal(report.topIssues[0].count, 1);
});
