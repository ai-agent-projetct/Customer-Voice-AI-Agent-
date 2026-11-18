// One conversation engine for every text channel: WhatsApp, Instagram DM,
// Facebook Messenger and the website chat. The same AI employee answers
// everywhere, remembers the customer across channels, and steps aside the
// moment a person takes over from the Inbox.
import { respond } from "./agent.js";
import { endCall, startCall } from "./calls.js";
import { phrase } from "./languages.js";
import { metaTransport } from "./meta.js";
import { notifyOwner, queueMessage } from "./messaging.js";
import { canTakeCalls } from "./plans.js";
import { normalizePhone, samePhone } from "./util.js";

export const CHAT_CHANNELS = ["whatsapp", "instagram", "messenger", "widget"];
const IDLE_MS = 24 * 3600e3; // a conversation stays open for a day of silence
const ALERT_EVERY_MS = 10 * 60e3; // don't buzz the owner for every message in a human-handled chat

const keyOf = (call) => call.callerNumber || call.externalId;

/** The customer behind a social account, created on first contact. */
function socialCustomer(db, orgId, channel, externalId, name) {
  const found = db.find("customers", (c) => c.orgId === orgId && c.socialIds?.[channel] === externalId)[0];
  if (found) return found;
  return db.insert("customers", { orgId, phone: "", name: name || "", notes: "", calls: 0, doNotCall: false, lastCallAt: null, socialIds: { [channel]: externalId } });
}

function findConversation(db, agentIds, channel, key) {
  const since = new Date(Date.now() - IDLE_MS).toISOString();
  return db
    .find("calls", (c) => agentIds.includes(c.agentId) && c.channel === channel && c.status === "live" && keyOf(c) === key && (c.transcript.at(-1)?.at ?? c.createdAt) > since)
    .at(-1);
}

/**
 * A customer wrote to the business. Returns { reply } — reply is null when a
 * person is handling the conversation (their answer comes from the Inbox).
 * `from` is a phone number (WhatsApp) or the channel's user id (Instagram, Messenger).
 */
export async function handleIncoming(db, { agent, channel, from, text, name = "", call = null }) {
  const org = db.get("orgs", agent.orgId);
  if (!org || !canTakeCalls(db, org)) return { reply: "Sorry, we can't reply here right now. Please call us.", call: null };
  const isPhone = channel === "whatsapp";
  const key = isPhone ? normalizePhone(from) : String(from);
  const team = db.find("agents", (a) => a.orgId === agent.orgId).map((a) => a.id);
  call ??= findConversation(db, team, channel, key);
  if (!call) {
    const customer = isPhone ? null : socialCustomer(db, agent.orgId, channel, key, name);
    call = startCall(db, agent, {
      channel,
      ...(isPhone ? { callerNumber: key } : { externalId: key, customerId: customer.id, customerName: customer.name || name }),
      greeting: phrase(agent.language, "chat", { org: org.name }),
    });
    if (!isPhone) db.update("customers", customer.id, { calls: (customer.calls || 0) + 1, lastCallAt: new Date().toISOString() });
  }
  const current = db.get("agents", call.agentId) ?? agent; // a colleague may have taken it over

  if (call.humanMode) {
    call.transcript.push({ role: "caller", text, at: new Date().toISOString() });
    const quiet = call.lastOwnerAlert && Date.now() - Date.parse(call.lastOwnerAlert) < ALERT_EVERY_MS;
    db.update("calls", call.id, { transcript: call.transcript, ...(quiet ? {} : { lastOwnerAlert: new Date().toISOString() }) });
    if (!quiet) notifyOwner(db, agent.orgId, { kind: "inbox", title: `New ${channel} message`, body: `${call.customerName || keyOf(call)}: ${text.slice(0, 160)}`, callId: call.id });
    return { reply: null, call };
  }

  const { reply, action } = await respond(db, current, call, text);
  linkCustomer(db, call);
  if (action?.type === "hangup") endCall(db, call, "completed");
  if (action?.type === "transfer") {
    // In a chat, "speak to a person" means the team takes over this conversation.
    db.update("calls", call.id, { humanMode: true, humanRequestedAt: new Date().toISOString() });
    notifyOwner(db, agent.orgId, { kind: "inbox", title: `Customer wants a person (${channel})`, body: `${call.customerName || keyOf(call)}: ${action.reason || text}`.slice(0, 240), callId: call.id, urgent: true });
    return { reply: `${reply}\n${handoverNote(org)}`.trim(), call };
  }
  return { reply, call };
}

function handoverNote(org) {
  return `A member of the ${org.name} team will reply here shortly.`;
}

/**
 * Instagram and Messenger don't share phone numbers. When a customer gives
 * one in chat (to book, order or leave a lead), link their social profile to
 * that phone's customer record, so every channel shares one history.
 */
function linkCustomer(db, call) {
  if (call.callerNumber || !call.customerId) return;
  const phone = [
    ...db.find("appointments", (a) => a.callId === call.id),
    ...db.find("leads", (l) => l.callId === call.id),
    ...db.find("orders", (o) => o.callId === call.id),
  ].map((r) => r.phone).find(Boolean);
  if (!phone) return;
  const social = db.get("customers", call.customerId);
  if (!social || social.phone) return;
  const clean = normalizePhone(phone);
  const existing = db.find("customers", (c) => c.orgId === social.orgId && c.id !== social.id && samePhone(c.phone, clean))[0];
  if (existing) {
    db.update("customers", existing.id, { socialIds: { ...(existing.socialIds || {}), ...(social.socialIds || {}) }, name: existing.name || social.name, calls: (existing.calls || 0) + (social.calls || 0) });
    db.find("calls", (c) => c.customerId === social.id).forEach((c) => db.update("calls", c.id, { customerId: existing.id }));
    db.remove("customers", social.id);
  } else {
    db.update("customers", social.id, { phone: clean });
  }
}

/** A person on the team answers from the Inbox: delivered on the conversation's own channel. */
export async function sendHumanReply(db, call, text, by) {
  const at = new Date().toISOString();
  call.transcript.push({ role: "human", text, by, at });
  db.update("calls", call.id, { transcript: call.transcript, humanMode: true, lastHumanReplyAt: at });
  const agent = db.get("agents", call.agentId);
  if (call.channel === "whatsapp") {
    const msg = queueMessage(db, { orgId: call.orgId, to: call.callerNumber, kind: "inbox_reply", call, body: text, channel: "whatsapp" });
    return { delivered: msg?.status ?? "queued" };
  }
  if (call.channel === "instagram" || call.channel === "messenger") {
    const org = db.get("orgs", call.orgId);
    return metaTransport.send({ channel: call.channel, pageId: call.channel === "instagram" ? agent?.instagramId : agent?.messengerPageId, recipientId: call.externalId, text, token: org?.metaPageToken });
  }
  return { delivered: "in-app" }; // the website chat picks it up on its next poll
}

export function closeConversation(db, call) {
  endCall(db, call, call.humanMode ? "handled-by-team" : "completed");
}
