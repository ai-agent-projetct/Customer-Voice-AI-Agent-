// One-off AI calls that we place: callbacks a caller asked for, instant
// calls to new leads ("speed to lead"), calls started through the API, and
// click-to-call bridges between the owner and a customer.
//
// The same rules as campaigns apply, enforced here: calls only go out between
// 9am and 9pm in the business's time zone, never to do-not-call numbers, and
// every AI call opens by saying it is an AI assistant and who it calls for.
import { startCall } from "./calls.js";
import { findCustomer, upsertCustomer } from "./customers.js";
import { agentLanguages, phrase } from "./languages.js";
import { usage } from "./plans.js";
import { dialer, publicUrl } from "./telephony.js";
import { localParts, minutesBetween, normalizePhone } from "./util.js";

const MAX_ATTEMPTS = 3;

/**
 * Queue an AI call. `when` is { date, time } in the business's time zone, or
 * omitted for "as soon as allowed". Returns the queued row.
 */
export function queueAiCall(db, agent, { phone, name = "", reason, goal = "", when = null, language, source, consent = false, leadId = null }) {
  return db.insert("callbacks", {
    orgId: agent.orgId, agentId: agent.id, phone: normalizePhone(phone), name, reason, goal,
    date: when?.date ?? null, time: when?.time ?? null, language: language ?? null,
    status: "pending", attempts: 0, source, consent, leadId,
  });
}

function due(row, agent, now) {
  if (!row.date) return true;
  const local = localParts(agent.timeZone, now);
  return minutesBetween(local.date, local.time, row.date, row.time) <= 0;
}

/** Called by the scheduler (and right after queueing): place every call that is due and allowed. */
export async function placeDueCalls(db, now = new Date()) {
  for (const row of db.find("callbacks", (c) => c.status === "pending")) {
    const agent = db.get("agents", row.agentId);
    const org = agent && db.get("orgs", agent.orgId);
    if (!agent || !org) {
      db.update("callbacks", row.id, { status: "failed", error: "Receptionist was deleted." });
      continue;
    }
    if (row.retryAt && row.retryAt > now.toISOString()) continue;
    if (!due(row, agent, now)) continue;
    const { time } = localParts(agent.timeZone, now);
    if (time < "09:00" || time >= "21:00") continue; // wait for calling hours
    const customer = findCustomer(db, org.id, row.phone);
    if (customer?.doNotCall) {
      db.update("callbacks", row.id, { status: "skipped", error: "On do-not-call list" });
      continue;
    }
    if (usage(db, org, now).overLimit) {
      db.update("callbacks", row.id, { status: "failed", error: "Plan minutes used up." });
      continue;
    }
    if (row.name && !customer?.name) upsertCustomer(db, org.id, row.phone, { name: row.name });
    const spoken = agentLanguages(agent);
    const language = [row.language, customer?.preferredLanguage].find((c) => c && spoken.includes(c)) ?? agent.language;
    const first = (row.name || customer?.name || "").split(/\s+/)[0];
    const call = startCall(db, agent, {
      channel: "phone", direction: "outbound", callerNumber: row.phone, language, silences: 0,
      callbackId: row.id, goal: row.goal || `You are calling back about: ${row.reason}. Help them with it.`,
      greeting: `${phrase(language, "aiCall", { name: first ? ` ${first}` : "", org: org.name })} ${row.opening || ""}`.trim(),
    });
    const placed = await dialer.call({ to: row.phone, url: publicUrl(`/twilio/outbound/${call.id}`), statusCallback: publicUrl("/twilio/status") });
    if (placed.ok) {
      db.update("calls", call.id, { twilioSid: placed.sid });
      db.update("callbacks", row.id, { status: "calling", callId: call.id, attempts: (row.attempts || 0) + 1 });
    } else {
      db.remove("calls", call.id);
      db.update("callbacks", row.id, { status: "failed", error: placed.error });
    }
  }
}

/** A queued call ended: done, or try again in 30 minutes if nobody answered. */
export function outboundCallEnded(db, call, outcome) {
  const row = db.get("callbacks", call.callbackId);
  if (!row) return;
  const reached = ["completed", "transferred", "caller-hung-up"].includes(outcome);
  if (reached) db.update("callbacks", row.id, { status: "done", result: outcome });
  else if ((row.attempts || 0) < MAX_ATTEMPTS) db.update("callbacks", row.id, { status: "pending", retryAt: new Date(Date.now() + 30 * 60e3).toISOString(), result: outcome });
  else db.update("callbacks", row.id, { status: "failed", error: `No answer after ${MAX_ATTEMPTS} attempts` });
}

/**
 * Click-to-call: ring the owner's phone first, then connect the customer.
 * The customer sees the business number, not the owner's mobile.
 */
export async function bridgeCall(db, org, { to, customerName }) {
  if (!org.ownerPhone) return { ok: false, error: "Add your mobile number in Settings first." };
  const call = db.insert("calls", {
    orgId: org.id, agentId: null, agentName: "You (click-to-call)", channel: "bridge", direction: "outbound", status: "live",
    callerNumber: normalizePhone(to), customerName, customerId: findCustomer(db, org.id, to)?.id ?? null,
    transcript: [], messages: [], summary: "Click-to-call by the owner", durationSec: 0,
  });
  const placed = await dialer.call({ to: org.ownerPhone, url: publicUrl(`/twilio/bridge/${call.id}`), statusCallback: publicUrl("/twilio/status") });
  if (!placed.ok) {
    db.remove("calls", call.id);
    return placed;
  }
  db.update("calls", call.id, { twilioSid: placed.sid });
  return { ok: true, callId: call.id };
}
