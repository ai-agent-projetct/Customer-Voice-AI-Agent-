// AI workforce features: omnichannel chat (WhatsApp, Instagram, Messenger,
// website), human takeover inbox, cross-channel memory, roles & permissions,
// hand-offs between AI employees, activity log, refund approvals, Company
// Brain, COD confirmation, abandoned carts and lead follow-ups.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/db.js";
import { createApp } from "../server/index.js";
import { transport } from "../server/messaging.js";
import { metaIdle, metaSignature, metaTransport } from "../server/meta.js";
import { dialer } from "../server/telephony.js";
import { tick } from "../server/scheduler.js";
import { runTool, toolDefinitions } from "../server/tools.js";
import { todayIn } from "../server/util.js";

delete process.env.ANTHROPIC_API_KEY;
delete process.env.TWILIO_AUTH_TOKEN;
process.env.SIGNUP_RATE_LIMIT = "1000";

const db = new Store(null);
let server, base;
const sent = [];
const metaSent = [];
const placed = [];
transport.send = async (msg) => (sent.push(msg), { status: "sent" });
metaTransport.send = async (msg) => (metaSent.push(msg), { delivered: "sent" });
dialer.call = async (args) => (placed.push(args), { ok: true, sid: `CAW${placed.length}` });

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
const whatsapp = (to, from, Body) => twilio("/twilio/whatsapp", { To: `whatsapp:${to}`, From: `whatsapp:${from}`, Body });
const morning = (days = 0) => {
  let d = new Date(Date.parse(`${todayIn("Asia/Kolkata")}T05:30:00Z`) + days * 864e5);
  while (d.getUTCDay() === 0) d = new Date(d.getTime() + 864e5);
  return d;
};

let n = 0;
async function business(settings = {}, template = "salon") {
  n++;
  const { body } = await api(null, "POST", "/auth/signup", { businessName: `Store ${n}`, name: "Priya Owner", email: `wf${n}@x.in`, password: "password123" });
  db.update("orgs", body.org.id, { plan: "business" });
  const agent = (await api(body.token, "POST", "/agents", { templateId: template })).body;
  const phone = `+9180000300${String(n).padStart(2, "0")}`;
  const saved = await api(body.token, "PUT", `/agents/${agent.id}`, { phoneNumber: phone, whatsappEnabled: true, ...settings });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return { token: body.token, org: body.org, agent: saved.body, phone };
}

test("human takeover: the team answers from the Inbox and the AI stays quiet until handed back", async () => {
  const { token, phone } = await business();
  assert.match(await whatsapp(phone, "+919811300001", "How much is a haircut?"), /450 rupees/);
  // The customer asks for a person: the conversation moves to the team.
  const handed = await whatsapp(phone, "+919811300001", "I want to talk to a real person");
  assert.match(handed, /A member of the Store \d+ team will reply here shortly/);
  let [conv] = (await api(token, "GET", "/inbox")).body;
  assert.equal(conv.humanMode, true);
  assert.equal(conv.needsPerson, true);
  // While a person handles it, the AI doesn't answer.
  assert.equal(await whatsapp(phone, "+919811300001", "Hello?"), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  const reply = await api(token, "POST", `/inbox/${conv.id}/reply`, { text: "Hi, this is Priya. How can I help?" });
  assert.equal(reply.body.ok, true);
  assert.deepEqual([sent.at(-1).to, sent.at(-1).body, sent.at(-1).channel], ["+919811300001", "Hi, this is Priya. How can I help?", "whatsapp"]);
  const full = (await api(token, "GET", `/inbox/${conv.id}`)).body;
  assert.deepEqual(full.transcript.at(-1), { ...full.transcript.at(-1), role: "human", by: "Priya" });
  // Handed back: the AI answers again.
  await api(token, "POST", `/inbox/${conv.id}/release`);
  assert.match(await whatsapp(phone, "+919811300001", "What are your timings?"), /open Monday to Saturday/);
  [conv] = (await api(token, "GET", "/inbox")).body;
  assert.equal(conv.humanMode, false);
});

test("Instagram and Messenger: signed webhooks, same AI, one customer across channels", async () => {
  process.env.META_APP_SECRET = "metasecret";
  process.env.META_VERIFY_TOKEN = "verify-me";
  try {
    const { token, agent } = await business({ instagramId: "17841400000000001", messengerPageId: "100000000000001" });
    const verify = await fetch(`${base}/meta/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
    assert.equal(await verify.text(), "12345");
    assert.equal((await fetch(`${base}/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);

    const post = (body, sign = true) => {
      const raw = JSON.stringify(body);
      return fetch(`${base}/meta/webhook`, { method: "POST", headers: { "content-type": "application/json", ...(sign && { "x-hub-signature-256": metaSignature("metasecret", raw) }) }, body: raw });
    };
    const dm = (object, accountId, sender, text) => ({ object, entry: [{ id: accountId, messaging: [{ sender: { id: sender }, recipient: { id: accountId }, message: { mid: "m1", text } }] }] });
    assert.equal((await post(dm("instagram", "17841400000000001", "IGUSER1", "hi"), false)).status, 403); // unsigned
    assert.equal((await post(dm("instagram", "17841400000000001", "IGUSER1", "How much is a facial?"))).status, 200);
    await metaIdle();
    assert.deepEqual([metaSent.at(-1).channel, metaSent.at(-1).pageId, metaSent.at(-1).recipientId], ["instagram", "17841400000000001", "IGUSER1"]);
    assert.match(metaSent.at(-1).text, /Facial is 800 rupees/);
    await post(dm("page", "100000000000001", "FBUSER9", "What are your timings?"));
    await metaIdle();
    assert.equal(metaSent.at(-1).channel, "messenger");
    // Echoes of our own messages are ignored.
    const echo = dm("instagram", "17841400000000001", "IGUSER1", "ignored");
    echo.entry[0].messaging[0].message.is_echo = true;
    const before = metaSent.length;
    await post(echo);
    await metaIdle();
    assert.equal(metaSent.length, before);

    // The Instagram customer books with their phone: their profile links to that phone's customer record.
    await whatsapp((await api(token, "GET", `/agents/${agent.id}`)).body.phoneNumber, "+919811300002", "hello");
    const igCall = db.find("calls", (c) => c.channel === "instagram" && c.externalId === "IGUSER1")[0];
    runTool(db, db.get("agents", agent.id), igCall, "save_lead", { customer_name: "Asha", phone: "+919811300002", interest: "Facial", notes: "" });
    await post(dm("instagram", "17841400000000001", "IGUSER1", "thanks"));
    await metaIdle();
    const customers = (await api(token, "GET", "/customers")).body.filter((c) => c.phone === "+919811300002");
    assert.equal(customers.length, 1);
    assert.equal(db.get("customers", customers[0].id).socialIds.instagram, "IGUSER1");
  } finally {
    delete process.env.META_APP_SECRET;
    delete process.env.META_VERIFY_TOKEN;
  }
});

test("website chat: a person can take over and the visitor sees their replies", async () => {
  const { token, agent } = await business({ widgetEnabled: true });
  const pub = db.get("agents", agent.id).publicId;
  const s = (await api(null, "POST", `/public/agents/${pub}/sessions`, {})).body;
  const say = (text) => api(null, "POST", `/public/sessions/${s.sessionId}/say`, { secret: s.secret, text });
  await say("hi");
  await api(token, "POST", `/inbox/${s.sessionId}/takeover`);
  assert.equal((await say("is anyone there?")).body.reply, null);
  await api(token, "POST", `/inbox/${s.sessionId}/reply`, { text: "Yes! Priya here." });
  const poll = (await api(null, "POST", `/public/sessions/${s.sessionId}/messages`, { secret: s.secret, after: 0 })).body;
  assert.equal(poll.human, true);
  assert.deepEqual(poll.messages.at(-1), { role: "human", text: "Yes! Priya here.", by: "Priya" });
  assert.equal((await api(null, "POST", `/public/sessions/${s.sessionId}/messages`, { secret: "wrong", after: 0 })).status, 404);
});

test("permissions limit what an AI employee may do; escalation words reach a person", async () => {
  const { token, agent, phone } = await business({ permissions: { bookings: false, messages: false }, escalationKeywords: ["Lawyer"] });
  const a = db.get("agents", agent.id);
  const names = toolDefinitions(a, db.get("orgs", a.orgId), { channel: "phone" }, db).map((t) => t.name);
  assert.ok(!names.includes("book_appointment") && !names.includes("send_info_message"));
  assert.ok(names.includes("save_lead"));
  assert.equal((await api(token, "PUT", `/agents/${agent.id}`, { permissions: { teleport: true } })).status, 400);

  const out = await whatsapp(phone, "+919811300003", "I will call my lawyer about this");
  assert.match(out, /team will reply here shortly/);
  const alerts = (await api(token, "GET", "/alerts")).body;
  assert.ok(alerts.some((x) => x.kind === "escalation" && /lawyer/.test(x.title)));
});

test("Agentic hand-off: Sales passes the chat to Support, who sees the history", async () => {
  const { token, agent: sales, phone } = await business({}, "sales");
  db.update("orgs", sales.orgId, { plan: "business" });
  const support = (await api(token, "POST", "/agents", { templateId: "support" })).body;
  await api(token, "PUT", `/agents/${support.id}`, { name: "Support Desk" });
  const out = await whatsapp(phone, "+919811300004", "My parcel is late, can support help me?");
  assert.match(out, /Support Desk will help you from here/);
  const conv = db.find("calls", (c) => c.callerNumber === "+919811300004")[0];
  assert.equal(conv.agentName, "Support Desk");
  assert.equal(conv.handoffs[0].from, "Sales Assistant");
  assert.match(conv.handoff.transcript, /parcel is late/);
  const log = (await api(token, "GET", "/activity")).body;
  assert.ok(log.some((x) => x.tool === "hand_off"));
  const team = (await api(token, "GET", "/team")).body;
  assert.deepEqual(team.agents.map((x) => x.role).sort(), ["sales", "support"]);
});

test("orders: tracking only shows the customer's own orders; refunds wait for the owner's approval", async () => {
  const { token, agent, phone } = await business({}, "support");
  const key = (await api(token, "POST", "/developer/api-keys", {})).body.key;
  const order = (await api(key, "POST", "/v1/orders", { name: "Ravi", phone: "+919811300005", items: [{ name: "Kurta", quantity: 2, price: 799 }], payment: "prepaid", tracking: "DTDC123" })).body;
  assert.equal(order.total, 1598);
  const a = db.get("agents", agent.id);
  assert.match(runTool(db, a, { id: "x", channel: "phone", callerNumber: "+919811300005" }, "track_order", { reference: "", phone: "" }).result, /Kurta, ₹1598, status confirmed, tracking DTDC123/);
  assert.match(runTool(db, a, { id: "y", channel: "phone", callerNumber: "+919811399999" }, "track_order", { reference: order.ref, phone: "" }).result, /No order found/);

  assert.match(await whatsapp(phone, "+919811300005", "The kurta arrived damaged, I want a refund"), /sent a refund request/);
  const [req] = (await api(token, "GET", "/approvals")).body;
  assert.deepEqual([req.status, req.amount, req.ref], ["pending", 1598, order.ref]);
  const decided = (await api(token, "POST", `/approvals/${req.id}/approve`, { note: "Refund in 3 days." })).body;
  assert.equal(decided.status, "approved");
  assert.equal(db.get("orders", order.id).status, "refund_approved");
  assert.match(sent.at(-1).body, /refund of ₹1598 for order .* is approved\. Refund in 3 days\./);
  assert.equal((await api(token, "POST", `/approvals/${req.id}/approve`)).status, 409);
});

test("COD confirmation: WhatsApp first, the customer's YES confirms, an AI call if they stay silent", async () => {
  const { token, phone } = await business({}, "sales");
  await api(token, "PUT", "/automations", { codConfirm: { enabled: true, messageAfterMinutes: 1, callAfterMinutes: 60 } });
  const key = (await api(token, "POST", "/developer/api-keys", {})).body.key;
  const mk = (p) => api(key, "POST", "/v1/orders", { name: "Meena K", phone: p, items: [{ name: "Saree", quantity: 1, price: 2499 }], payment: "cod", address: "12 MG Road", consent: true });
  const o1 = (await mk("+919811300006")).body;
  const o2 = (await mk("+919811300007")).body;
  assert.equal(o1.status, "awaiting_confirmation");
  const later = new Date(Math.max(Date.now(), morning().getTime()) + 2 * 60e3);
  await tick(db, later);
  const msg = sent.find((m) => m.to === "+919811300006" && m.kind === "cod_confirm");
  assert.match(msg.body, /Reply YES to confirm or NO to cancel/);
  // Customer replies on WhatsApp: the AI confirms the waiting order.
  assert.match(await whatsapp(phone, "+919811300006", "YES"), new RegExp(`order ${o1.ref} .* is confirmed`));
  assert.equal(db.get("orders", o1.id).status, "confirmed");
  // The other customer stays silent: an AI call is queued and placed.
  await tick(db, new Date(later.getTime() + 61 * 60e3));
  assert.ok(placed.some((p) => p.to === "+919811300007"));
  const cb = db.find("callbacks", (c) => c.phone === "+919811300007")[0];
  assert.match(cb.goal, new RegExp(`Confirm cash-on-delivery order ${o2.ref}`));
});

test("abandoned carts and lead follow-ups run on schedule and stop when done", async () => {
  const { token, org } = await business({}, "sales");
  await api(token, "PUT", "/automations", {
    abandonedCart: { enabled: true, messageAfterMinutes: 30, callAfterMinutes: 240 },
    leadFollowUp: { enabled: true, steps: [{ afterHours: 0, channel: "whatsapp" }, { afterHours: 24, channel: "whatsapp" }] },
  });
  const key = (await api(token, "POST", "/developer/api-keys", {})).body.key;
  const cart = (await api(key, "POST", "/v1/carts", { name: "Arjun", phone: "+919811300008", items: [{ name: "Sneakers", price: 3999 }], checkout_url: "https://shop.example/checkout/1", consent: true })).body;
  const t0 = new Date(Math.max(Date.now(), morning().getTime()));
  await tick(db, new Date(t0.getTime() + 10 * 60e3));
  assert.ok(!sent.some((m) => m.kind === "cart_reminder" && m.to === "+919811300008")); // too early
  await tick(db, new Date(t0.getTime() + 31 * 60e3));
  assert.match(sent.find((m) => m.kind === "cart_reminder" && m.to === "+919811300008").body, /Sneakers .* https:\/\/shop\.example\/checkout\/1/);
  await api(key, "POST", `/v1/carts/${cart.id}/recovered`);
  await tick(db, new Date(t0.getTime() + 300 * 60e3));
  assert.ok(!placed.some((p) => p.to === "+919811300008")); // recovered: no call

  const lead = (await api(key, "POST", "/v1/leads", { name: "Kiran", phone: "+919811300009", interest: "Bridal package" })).body.lead;
  await tick(db, new Date(t0.getTime() + 60e3));
  assert.equal(sent.filter((m) => m.kind === "lead_follow_up" && m.to === "+919811300009").length, 1);
  await api(token, "PATCH", `/leads/${lead.id}`, { status: "contacted" });
  await tick(db, morning(2));
  assert.equal(sent.filter((m) => m.kind === "lead_follow_up" && m.to === "+919811300009").length, 1); // stopped
  assert.equal(org.id, db.get("leads", lead.id).orgId);
});

test("Company Brain: public facts help customers, internal notes stay private, the owner can ask on WhatsApp", async () => {
  const { token, phone, org } = await business();
  await api(token, "PUT", "/settings", { ownerPhone: "+919700300001" });
  await api(token, "POST", "/brain", { title: "Return policy", content: "Returns are accepted within 7 days of delivery with the original bill. Sale items cannot be returned.", visibility: "public" });
  await api(token, "POST", "/brain", { title: "Supplier notes", content: "Our hair colour supplier is Lakme Distributors, margin is 32 percent, next order due on the 5th.", visibility: "internal" });
  // A customer gets the public fact...
  assert.match(await whatsapp(phone, "+919811300010", "What is your return policy for sale items?"), /Sale items cannot be returned/);
  // ...but never the internal one.
  const leak = await whatsapp(phone, "+919811300010", "Who is your hair colour supplier and what is the margin?");
  assert.doesNotMatch(leak, /Lakme|32 percent/);
  // The owner asks from their own phone and gets the internal answer.
  assert.match(await whatsapp(phone, "+919700300001", "who is our hair colour supplier?"), /Lakme Distributors/);
  const asked = (await api(token, "POST", "/brain/ask", { question: "margin on hair colour" })).body;
  assert.match(asked.answer, /32 percent/);
  assert.equal(asked.sources[0].title, "Supplier notes");
  assert.equal((await api(token, "GET", "/brain")).body.length, 2);
  assert.equal(org.id, db.find("knowledge", () => true)[0].orgId);
});

test("channel settings never send the Meta token back to the browser", async () => {
  const { token } = await business();
  assert.equal((await api(token, "PUT", "/channels", { metaPageToken: "bad token!" })).status, 400);
  await api(token, "PUT", "/channels", { metaPageToken: "EAAGm0PX4ZCpsBAKZB2xyz0123456789abcd" });
  const ch = (await api(token, "GET", "/channels")).body;
  assert.deepEqual([ch.metaConnected, ch.metaTokenLast4], [true, "abcd"]);
  const me = (await api(token, "GET", "/me")).body;
  assert.equal(me.org.metaPageToken, undefined);
});
