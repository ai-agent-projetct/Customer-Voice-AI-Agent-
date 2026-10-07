// Phone calls through Twilio. How a call flows:
//   1. Someone dials the business's Twilio number (or a campaign calls them).
//   2. Twilio POSTs to /twilio/voice (or /twilio/outbound/<callId>). We reply
//      with TwiML (XML instructions): "say this, then listen" (<Gather>).
//   3. Twilio turns the caller's speech into text and POSTs it to /twilio/gather.
//   4. We ask the agent's brain for a reply and answer with more TwiML. Repeat.
import crypto from "node:crypto";
import express from "express";
import { endCall, startCall } from "../calls.js";
import { greetingFor, respond } from "../agent.js";
import { findCustomer } from "../customers.js";
import { agentLanguages, lang, menuLines, phrase, pickLanguage } from "../languages.js";
import { switchLanguage } from "../tools.js";
import { escapeXml, sayXml, speakXml } from "../tts.js";
import { notifyOwner } from "../messaging.js";
import { canTakeCalls } from "../plans.js";
import { normalizePhone } from "../util.js";
import { wrap } from "./helpers.js";

const MAX_SILENCES = 2;
const FAILED_STATUSES = ["busy", "failed", "no-answer", "canceled"];

export function twilioRouter(db) {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));
  r.use(verifyTwilioSignature);

  r.post("/voice", wrap(async (req, res) => {
    const to = normalizePhone(req.body.To || "");
    const agent = db.find("agents", (a) => a.phoneNumber && a.phoneNumber === to && a.active)[0];
    if (!agent) return twiml(res, `<Say>Sorry, this number is not set up yet. Goodbye.</Say><Hangup/>`);
    const org = db.get("orgs", agent.orgId);
    const main = agent.language;

    if (!org || !canTakeCalls(db, org)) {
      // Plan minutes used up: never drop the customer, hand them to a person.
      notifyOwner(db, agent.orgId, { kind: "limit", title: "Plan minutes used up", body: `A call from ${req.body.From || "a caller"} was passed to you. Upgrade to keep your receptionist answering.`, urgent: true });
      const human = agent.transferNumber || org?.ownerPhone;
      return twiml(res, human
        ? `${sayXml(agent, main, phrase(main, "connecting"))}<Dial>${escapeXml(human)}</Dial>`
        : `${sayXml(agent, main, "Sorry, we can't take your call right now. Please try again later. Goodbye.")}<Hangup/>`);
    }

    const callerNumber = normalizePhone(req.body.From || "");
    const known = findCustomer(db, agent.orgId, callerNumber);
    const spoken = agentLanguages(agent);
    // Several languages and no remembered preference: let the caller choose.
    const menu = spoken.length > 1 && agent.languageMenu !== false && !spoken.includes(known?.preferredLanguage);
    const call = startCall(db, agent, {
      channel: "phone",
      callerNumber,
      twilioSid: req.body.CallSid || "",
      silences: 0,
      ...(menu && { greeting: `[Language menu: ${spoken.map((c) => lang(c).native).join(" · ")}]`, awaitingLanguage: true }),
    });
    if (menu) return twiml(res, await languageMenu(agent, call));
    twiml(res, await gather(agent, call, call.greeting));
  }));

  // The caller pressed a key or said a language name (or said nothing: main language).
  r.post("/language/:callId", wrap(async (req, res) => {
    const call = db.get("calls", req.params.callId);
    const agent = call && db.get("agents", call.agentId);
    if (!call || !agent || call.status === "ended") return twiml(res, "<Hangup/>");
    const code = pickLanguage(agent, { digits: req.body.Digits, speech: req.body.SpeechResult }) ?? agent.language;
    switchLanguage(db, agent, call, code, "menu");
    const customer = call.customerId ? db.get("customers", call.customerId) : null;
    if (customer) db.update("customers", customer.id, { preferredLanguage: code });
    const greeting = greetingFor(agent, customer, code, db.get("orgs", agent.orgId)?.name);
    call.transcript.push({ role: "agent", text: greeting, at: new Date().toISOString() });
    db.update("calls", call.id, { greeting, awaitingLanguage: false, transcript: call.transcript });
    twiml(res, await gather(agent, call, greeting));
  }));

  // Campaign calls: Twilio fetches this when the person picks up.
  r.post("/outbound/:callId", wrap(async (req, res) => {
    const call = db.get("calls", req.params.callId);
    const agent = call && db.get("agents", call.agentId);
    if (!call || !agent || call.status === "ended") return twiml(res, "<Hangup/>");
    db.update("calls", call.id, { answeredAt: new Date().toISOString(), twilioSid: req.body.CallSid || call.twilioSid });
    twiml(res, await gather(agent, call, call.greeting));
  }));

  r.post("/gather/:callId", wrap(async (req, res) => {
    const call = db.get("calls", req.params.callId);
    const agent = call && db.get("agents", call.agentId);
    if (!call || !agent || call.status === "ended") return twiml(res, "<Hangup/>");
    const code = () => call.language ?? agent.language;

    // The owner pressed "Take over" in the live view.
    const owner = db.get("orgs", agent.orgId)?.ownerPhone || agent.transferNumber;
    if (call.takeover && owner) {
      endCall(db, call, "taken-over");
      return twiml(res, `${await speakXml(agent, code(), phrase(code(), "connecting"))}<Dial>${escapeXml(owner)}</Dial>`);
    }

    const heard = String(req.body.SpeechResult || "").trim();
    if (!heard) {
      const silences = (call.silences || 0) + 1;
      db.update("calls", call.id, { silences });
      if (silences > MAX_SILENCES) {
        endCall(db, call, "no-response");
        return twiml(res, `${await speakXml(agent, code(), phrase(code(), "noInput"))}<Hangup/>`);
      }
      return twiml(res, await gather(agent, call, phrase(code(), "retry")));
    }

    db.update("calls", call.id, { silences: 0 });
    // respond() may switch call.language; the reply is then spoken (and the
    // next turn heard) in the new language.
    const { reply, action } = await respond(db, agent, call, heard);
    if (action?.type === "hangup") {
      endCall(db, call, "completed");
      return twiml(res, `${await speakXml(agent, code(), reply)}<Hangup/>`);
    }
    if (action?.type === "transfer") {
      const human = agent.transferNumber || db.get("orgs", agent.orgId)?.ownerPhone;
      if (human) {
        endCall(db, call, "transferred");
        return twiml(res, `${await speakXml(agent, code(), reply)}<Dial>${escapeXml(human)}</Dial>`);
      }
    }
    twiml(res, await gather(agent, call, reply));
  }));

  // Set as the number's "Call status changes" webhook (campaign calls set it
  // automatically) to record durations and close calls when people hang up.
  r.post("/status", (req, res) => {
    const call = db.find("calls", (c) => c.twilioSid && c.twilioSid === req.body.CallSid)[0];
    const status = req.body.CallStatus;
    if (call && (status === "completed" || FAILED_STATUSES.includes(status))) {
      const duration = Number(req.body.CallDuration) || undefined;
      endCall(db, call, status === "completed" ? "caller-hung-up" : status, duration);
    }
    res.sendStatus(204);
  });

  return r;
}

/** Say `text`, then listen, both in the call's current language. */
async function gather(agent, call, text) {
  const code = call.language ?? agent.language;
  return (
    `<Gather input="speech" action="/twilio/gather/${call.id}" method="POST" ` +
    `language="${lang(code).code}" speechTimeout="auto" actionOnEmptyResult="true">` +
    `${await speakXml(agent, code, text)}</Gather>`
  );
}

/** "For English, press 1. हिंदी के लिए 2 दबाइए। ..." Each line in its own language's voice. */
async function languageMenu(agent, call) {
  const lines = menuLines(agent);
  const hints = agentLanguages(agent).flatMap((c) => lang(c).keywords).join(",");
  const spoken = (await Promise.all(lines.map((l) => speakXml(agent, l.code, l.text)))).join("");
  return (
    `<Gather input="dtmf speech" numDigits="1" timeout="6" action="/twilio/language/${call.id}" method="POST" ` +
    `language="${lang(agent.language).code}" hints="${escapeXml(hints)}">${spoken}</Gather>` +
    `<Redirect method="POST">/twilio/language/${call.id}</Redirect>`
  );
}

function twiml(res, body) {
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

export { escapeXml };

// Proves a request really came from Twilio, so nobody can fake calls.
// Twilio signs: full URL + each POST param (sorted by name, key then value),
// HMAC-SHA1 with your auth token, base64-encoded.
export function twilioSignature(authToken, url, params) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac("sha1", authToken).update(data).digest("base64");
}

function verifyTwilioSignature(req, res, next) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return next(); // local development without Twilio
  const base = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  const expected = twilioSignature(token, base + req.originalUrl, req.body || {});
  const given = req.get("x-twilio-signature") || "";
  const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return res.status(403).send("Invalid Twilio signature");
  next();
}
