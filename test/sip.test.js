// VoiceDesk Network: our own SIP/RTP telephony. A second SipUA plays the
// caller's phone and the operator's trunk; a tiny fake trunk checks digest
// authentication. (The same engine was also checked against the baresip
// softphone: see docs/TELEPHONY-PLATFORM.md.)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { Store } from "../server/db.js";
import { transport } from "../server/messaging.js";
import { startCall } from "../server/calls.js";
import { build, digest, header, param, parse, parseChallenge, response, verifyDigest } from "../server/sip/message.js";
import { buildSdp, chooseCodec, parseSdp } from "../server/sip/sdp.js";
import { RtpSession, bindRtpSocket } from "../server/sip/rtp.js";
import { SipUA } from "../server/sip/ua.js";
import { dialFormat, sipHooks, startSipGateway, stopSipGateway } from "../server/sip/gateway.js";
import { liveSessions, placeCall } from "../server/voice/router.js";
import { linearToAlaw, alawToLinear, tone } from "../server/voice/audio.js";

delete process.env.ANTHROPIC_API_KEY;
process.env.VOICE_ENGINE = "mock";
process.env.VOICE_SILENCE_MS = "60000";
transport.send = async () => ({ status: "sent" });

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};

// ---------------- Building blocks ----------------
test("SIP messages: parse compact headers, multiple Vias, build responses", () => {
  const raw = [
    "INVITE sip:+918047000001@10.0.0.1 SIP/2.0",
    "v: SIP/2.0/UDP 1.2.3.4:5060;branch=z9hG4bKa1;rport, SIP/2.0/UDP 5.6.7.8;branch=z9hG4bKb2",
    "f: \"Ravi, K\" <sip:+919811111111@op.in>;tag=abc",
    "t: <sip:+918047000001@op.in>",
    "i: call-1",
    "CSeq: 7 INVITE",
    "m: <sip:+919811111111@1.2.3.4:5060>",
    "c: application/sdp",
    "l: 4",
    "",
    "v=0\r\nextra",
  ].join("\r\n");
  const msg = parse(raw);
  assert.equal(msg.method, "INVITE");
  assert.equal(msg.headers.via.length, 2);
  assert.equal(header(msg, "from"), "\"Ravi, K\" <sip:+919811111111@op.in>;tag=abc");
  assert.equal(param(header(msg, "from"), "tag"), "abc");
  assert.equal(msg.body, "v=0\r", "Content-Length respected");
  const res = parse(response(msg, 200, { toTag: "xyz" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.via.length, 2);
  assert.equal(param(header(res, "to"), "tag"), "xyz");
  assert.equal(header(res, "cseq"), "7 INVITE");
  assert.match(build({ method: "BYE", uri: "sip:a@b", headers: [["Call-ID", "1"]] }), /^BYE sip:a@b SIP\/2\.0\r\nCall-ID: 1\r\nContent-Length: 0\r\n\r\n$/);
});

test("digest authentication matches the server-side check (with and without qop)", () => {
  for (const qop of ['qop="auth",', ""]) {
    const challenge = `Digest realm="op.in", nonce="n0nce", ${qop} algorithm=MD5`;
    const authorization = digest({ challenge, method: "INVITE", uri: "sip:+91@op.in", username: "acme", password: "s3cret" });
    assert.ok(verifyDigest({ authorization, method: "INVITE", password: "s3cret", realm: "op.in", nonce: "n0nce" }));
    assert.ok(!verifyDigest({ authorization, method: "INVITE", password: "wrong", realm: "op.in", nonce: "n0nce" }));
    assert.equal(parseChallenge(authorization).username, "acme");
  }
});

test("SDP offer/answer and A-law", () => {
  const sdp = buildSdp({ ip: "203.0.113.5", port: 12000 });
  assert.deepEqual(parseSdp(sdp), { ip: "203.0.113.5", port: 12000, payloadTypes: [0, 8, 101], dtmf: 101 });
  assert.equal(chooseCodec({ payloadTypes: [8, 0] }), 8, "caller's preference first");
  assert.equal(chooseCodec({ payloadTypes: [18, 9] }), null);
  for (const s of [0, 1000, -1000, 20000, -30000]) assert.ok(Math.abs(alawToLinear(linearToAlaw(s)) - s) <= Math.max(16, Math.abs(s) * 0.07));
  assert.equal(dialFormat("+91 98110 00002"), "+919811000002");
  assert.equal(dialFormat("+919811000002", "plain"), "919811000002");
  assert.equal(dialFormat("+919811000002", "national"), "09811000002");
});

test("RTP: paced audio both ways, keypad events, barge-in clear", async () => {
  const a = new RtpSession(await bindRtpSocket({ min: 40000, max: 40998 }), { payloadType: 8 });
  const b = new RtpSession(await bindRtpSocket({ min: 41000, max: 41998 }), { payloadType: 8 });
  a.setRemote("127.0.0.1", b.port);
  b.setRemote("127.0.0.1", a.port);
  let frames = 0;
  const digits = [];
  b.onAudio = (pcm) => { if (pcm.length === 160) frames++; };
  b.onDtmf = (d) => digits.push(d);
  a.play(tone(200));
  await until(() => frames >= 10);
  // RFC 4733 event "5", end bit set, sent 3 times as phones do: counted once.
  const ev = Buffer.from([0x80, 101, 0, 1, 0, 0, 0, 9, 0, 0, 0, 1, 5, 0x80, 0, 160]);
  const sender = dgram.createSocket("udp4");
  for (let i = 0; i < 3; i++) sender.send(ev, b.port, "127.0.0.1");
  setTimeout(() => sender.close(), 200);
  await until(() => digits.length === 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(digits, ["5"]);
  a.play(tone(2000));
  assert.ok(a.queuedMs() > 1500);
  a.clear();
  assert.equal(a.queuedMs(), 0);
  a.close();
  b.close();
});

// ---------------- Gateway end to end ----------------
const db = new Store(null);
let gateway, phone, org, agent;

before(async () => {
  org = db.insert("orgs", { name: "Glow Salon", plan: "business", ownerPhone: "+919845000001", timeZone: "Asia/Kolkata" });
  agent = db.insert("agents", {
    orgId: org.id, name: "Asha", active: true, language: "en-IN", languages: ["en-IN", "hi-IN"], languageMenu: false,
    businessName: "Glow Salon", services: [{ name: "Facial", price: 800, durationMin: 45 }], hours: {}, faqs: [], transferNumber: "+919845000001",
  });
  db.insert("numbers", { orgId: org.id, number: "+918047000001", carrier: "voicedesk", agentId: agent.id, outbound: true, token: "t" });
  // The "phone network": answers whatever VoiceDesk dials (the customer or the team).
  phone = await new SipUA({ port: 0, host: "127.0.0.1", rtp: { min: 42000, max: 42998 } }).start();
  phone.answered = [];
  phone.on("invite", async (leg) => { leg.ringing(); await leg.answer(); phone.answered.push(leg); });
  gateway = await startSipGateway(db, {
    port: 0, host: "127.0.0.1", publicIp: "127.0.0.1", rtp: { min: 43000, max: 43998 },
    trunk: { host: "127.0.0.1", port: phone.port, domain: "127.0.0.1" }, allowedIps: ["127.0.0.1"],
  });
});
after(() => {
  phone.stop();
  stopSipGateway();
});

const dialIn = (to = "+918047000001", from = "+919811111111") =>
  phone.invite({ to, from, dest: { address: "127.0.0.1", port: gateway.port }, domain: "127.0.0.1" });

test("incoming call: answered by the AI in its own voice, keypad switches language, hang-up recorded", async () => {
  const leg = await dialIn();
  const call = await until(() => db.find("calls", (c) => c.providerCallId === leg.callId)[0]);
  assert.equal(call.carrier, "voicedesk");
  assert.equal(call.callerNumber, "+919811111111");
  const session = await until(() => liveSessions.get(call.id));
  let heard = 0;
  leg.rtp.onAudio = (pcm) => { for (let i = 0; i < pcm.length; i += 40) if (Math.abs(pcm[i]) > 1000) { heard++; break; } };
  await until(() => heard > 5, 3000); // the greeting reached the caller's phone
  leg.rtp.play(tone(100));
  await until(() => session.ears.frames > 0);
  session.ears.say("How much is a facial?");
  await until(() => db.get("calls", call.id).transcript.some((t) => t.role === "agent" && /800/.test(t.text)));
  // Keypad 2 = second language (Hindi).
  const keypad = dgram.createSocket("udp4");
  keypad.send(Buffer.from([0x80, 101, 0, 2, 0, 0, 1, 0, 0, 0, 0, 2, 2, 0x80, 0, 160]), leg.rtp.remote.port, "127.0.0.1", () => keypad.close());
  await until(() => db.get("calls", call.id).language === "hi-IN");
  await leg.bye();
  await until(() => db.get("calls", call.id).status === "ended");
  assert.equal(db.get("calls", call.id).outcome, "caller-hung-up");
});

test("unknown numbers and unknown networks are refused (toll-fraud protection)", async () => {
  await assert.rejects(dialIn("+918000000000"), (err) => err.status === 404);
  // A stranger's SIP server (not in SIP_ALLOWED_IPS) gets 403.
  const stranger = dgram.createSocket("udp4");
  await new Promise((r) => stranger.bind(0, "127.0.0.2", r));
  const got = new Promise((resolve) => stranger.once("message", (m) => resolve(parse(m))));
  stranger.send(build({ method: "INVITE", uri: "sip:+918047000001@127.0.0.1", headers: [["Via", "SIP/2.0/UDP 127.0.0.2;branch=z9hG4bKx"], ["From", "<sip:x@evil>;tag=1"], ["To", "<sip:+918047000001@127.0.0.1>"], ["Call-ID", "fraud-1"], ["CSeq", "1 INVITE"]], body: buildSdp({ ip: "127.0.0.2", port: 9 }) }), gateway.port, "127.0.0.1");
  assert.equal((await got).status, 403);
  stranger.close();
  assert.ok(!db.find("calls", (c) => c.providerCallId === "fraud-1").length);
});

test("transfer to a person: VoiceDesk dials the team and joins the two calls' audio", async () => {
  const before = phone.answered.length;
  const leg = await dialIn("+918047000001", "+919822222222");
  const call = await until(() => db.find("calls", (c) => c.providerCallId === leg.callId)[0]);
  const session = await until(() => liveSessions.get(call.id));
  session.ears.say("I want to talk to a real person please");
  const human = await until(() => phone.answered.length > before && phone.answered.at(-1), 8000);
  assert.equal(human.toUser, "+919845000001", "the owner's phone was dialled");
  await until(() => db.get("calls", call.id).status === "ended");
  assert.equal(db.get("calls", call.id).outcome, "transferred");
  // Caller → team audio flows through VoiceDesk.
  let reached = 0;
  human.rtp.onAudio = (pcm) => { if (pcm.some((s) => Math.abs(s) > 1000)) reached++; };
  leg.rtp.play(tone(400));
  await until(() => reached > 3);
  await leg.bye();
  await until(() => human.state === "ended");
});

test("outbound: AI calls through our own trunk; busy is recorded; digest auth with the operator", async () => {
  // 1. Answered by the phone network.
  const before = phone.answered.length;
  const call = startCall(db, db.get("agents", agent.id), { channel: "phone", direction: "outbound", callerNumber: "+919811000009" });
  assert.equal((await placeCall(db, { call, to: "+919811000009" })).ok, true);
  const answered = await until(() => phone.answered.length > before && phone.answered.at(-1));
  assert.equal(answered.toUser, "+919811000009");
  assert.equal(answered.fromUser, "+918047000001", "caller ID is the business's number");
  const session = await until(() => liveSessions.get(call.id));
  await session.finish("completed");
  await until(() => answered.state === "ended");
  assert.equal(db.get("calls", call.id).status, "ended");

  // 2. Busy.
  phone.removeAllListeners("invite");
  phone.on("invite", (leg) => leg.reject(486));
  const busy = startCall(db, db.get("agents", agent.id), { channel: "phone", direction: "outbound", callerNumber: "+919811000010" });
  await placeCall(db, { call: busy, to: "+919811000010" });
  await until(() => db.get("calls", busy.id).status === "ended");
  assert.equal(db.get("calls", busy.id).outcome, "busy");
  phone.removeAllListeners("invite");
  phone.on("invite", async (leg) => { leg.ringing(); await leg.answer(); phone.answered.push(leg); });

  // 3. An operator that demands a password (401 → INVITE with Authorization).
  const trunk = dgram.createSocket("udp4");
  await new Promise((r) => trunk.bind(0, "127.0.0.1", r));
  const seen = [];
  trunk.on("message", (buf, rinfo) => {
    const m = parse(buf);
    if (!m.method) return;
    seen.push(m.method + (header(m, "authorization") ? "+auth" : ""));
    const reply = (text) => trunk.send(text, rinfo.port, rinfo.address);
    if (m.method === "INVITE" && !header(m, "authorization")) {
      return reply(response(m, 401, { toTag: "t1", extra: [["WWW-Authenticate", 'Digest realm="op.in", nonce="abc123", qop="auth", algorithm=MD5']] }));
    }
    if (m.method === "INVITE") {
      const ok = verifyDigest({ authorization: header(m, "authorization"), method: "INVITE", password: "trunk-pass", realm: "op.in", nonce: "abc123" });
      return reply(ok
        ? response(m, 200, { toTag: "t2", extra: [["Contact", `<sip:op@127.0.0.1:${trunk.address().port}>`], ["Content-Type", "application/sdp"]], body: buildSdp({ ip: "127.0.0.1", port: 9, payloadTypes: [8] }) })
        : response(m, 403, { toTag: "t2" }));
    }
    if (m.method === "BYE") reply(response(m, 200));
  });
  const authed = new SipUA({ port: 0, host: "127.0.0.1", rtp: { min: 44000, max: 44998 }, trunk: { host: "127.0.0.1", port: trunk.address().port, domain: "op.in", username: "acme", password: "trunk-pass" } });
  await authed.start();
  const leg = await authed.invite({ to: "+919811000011", from: "+918047000001" });
  assert.equal(leg.state, "confirmed");
  assert.equal(leg.rtp.payloadType, 8, "A-law chosen from the operator's answer");
  assert.deepEqual(seen.slice(0, 3), ["INVITE", "ACK", "INVITE+auth"]);
  await leg.bye();
  await until(() => seen.includes("BYE"));
  authed.stop();
  trunk.close();
});

test("a ringing outbound call can be cancelled", async () => {
  phone.removeAllListeners("invite");
  let ringing;
  phone.on("invite", (leg) => { leg.ringing(); ringing = leg; });
  const caller = new SipUA({ port: 0, host: "127.0.0.1", rtp: { min: 45000, max: 45998 }, trunk: { host: "127.0.0.1", port: phone.port } });
  await caller.start();
  const pending = caller.invite({ to: "+919811000012", from: "+918047000001" }).catch((err) => err);
  await until(() => ringing);
  const leg = [...caller.calls.values()][0];
  await leg.bye(); // CANCEL while ringing
  const result = await pending;
  assert.equal(result.status, 487);
  await until(() => ringing.state === "ended");
  caller.stop();
  phone.removeAllListeners("invite");
  phone.on("invite", async (l) => { l.ringing(); await l.answer(); phone.answered.push(l); });
  assert.ok(sipHooks.enabled);
});
