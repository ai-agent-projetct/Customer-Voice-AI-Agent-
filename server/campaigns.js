// Outbound calling campaigns (reminders, win-back, feedback) with the
// compliance rules enforced in code, not left to good intentions:
//   - every contact needs recorded consent (confirmed when the campaign is created)
//   - calls only go out inside the campaign's window (default 9:00–21:00, Mon–Sat)
//   - do-not-call requests are honoured instantly and permanently
//   - every call opens by saying it is an AI assistant and which business it's from
import { startCall } from "./calls.js";
import { findCustomer } from "./customers.js";
import { agentLanguages, phrase } from "./languages.js";
import { planOf, usage } from "./plans.js";
import { dialer, publicUrl } from "./telephony.js";
import { localParts, normalizePhone } from "./util.js";

export const MAX_CONTACTS = 2000;

export function parseContacts(text) {
  // One per line: "name, phone" or just "phone".
  const seen = new Set();
  const contacts = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const parts = line.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) continue;
    const phoneIdx = parts.findIndex((p) => /\d{7,}/.test(p.replace(/\D/g, "")));
    if (phoneIdx === -1) continue;
    const phone = normalizePhone(parts[phoneIdx]);
    if (seen.has(phone)) continue;
    seen.add(phone);
    contacts.push({ phone, name: parts.filter((_, i) => i !== phoneIdx).join(" ").slice(0, 80) });
  }
  return contacts;
}

/** "Hello Meena, this is an AI assistant calling from Glow Salon." in the call's language, then the owner's line. */
export function disclosureGreeting(org, contact, openingLine, code = "en-IN") {
  const first = contact.name?.split(/\s+/)[0];
  return `${phrase(code, "aiCall", { name: first ? ` ${first}` : "", org: org.name })} ${openingLine}`.trim();
}

/** Campaign calls use the customer's remembered language, else the campaign's. */
export function campaignLanguage(agent, campaign, customer) {
  const spoken = agentLanguages(agent);
  return [customer?.preferredLanguage, campaign.language].find((c) => c && spoken.includes(c)) ?? agent.language;
}

function inWindow(campaign, timeZone, now) {
  const { time, weekday } = localParts(timeZone, now);
  return campaign.window.days.includes(weekday) && time >= campaign.window.start && time < campaign.window.end;
}

/** Called by the scheduler: starts the next calls for every running campaign. */
export async function dialCampaigns(db, now = new Date()) {
  for (const campaign of db.find("campaigns", (c) => c.status === "running")) {
    const org = db.get("orgs", campaign.orgId);
    const agent = db.get("agents", campaign.agentId);
    if (!org || !agent) {
      db.update("campaigns", campaign.id, { status: "paused", lastError: "Receptionist was deleted." });
      continue;
    }
    if (!planOf(org).campaigns || usage(db, org, now).overLimit) {
      db.update("campaigns", campaign.id, { status: "paused", lastError: "Your plan's minutes are used up or it doesn't include campaigns." });
      continue;
    }
    if (!inWindow(campaign, agent.timeZone, now)) continue;

    const active = campaign.contacts.filter((c) => c.status === "calling").length;
    let slots = Math.max(0, campaign.maxConcurrent - active);
    for (const contact of campaign.contacts) {
      if (slots <= 0) break;
      if (contact.status !== "pending") continue;
      if (contact.retryAt && contact.retryAt > now.toISOString()) continue; // waiting before the next attempt
      const customer = findCustomer(db, org.id, contact.phone);
      if (customer?.doNotCall) {
        contact.status = "skipped";
        contact.result = "On do-not-call list";
        continue;
      }
      const language = campaignLanguage(agent, campaign, customer);
      const call = startCall(db, agent, {
        channel: "phone",
        direction: "outbound",
        callerNumber: contact.phone,
        campaignId: campaign.id,
        language,
        greeting: disclosureGreeting(org, contact, campaign.openingLine, language),
        silences: 0,
      });
      contact.status = "calling";
      contact.callId = call.id;
      contact.attempts = (contact.attempts || 0) + 1;
      slots--;
      const placed = await dialer.call({
        to: contact.phone,
        url: publicUrl(`/twilio/outbound/${call.id}`),
        statusCallback: publicUrl("/twilio/status"),
      });
      if (placed.ok) {
        db.update("calls", call.id, { twilioSid: placed.sid });
      } else {
        contact.status = "pending"; // try again once calling works
        contact.callId = null;
        contact.attempts -= 1;
        db.remove("calls", call.id);
        db.update("campaigns", campaign.id, { status: "paused", lastError: placed.error, contacts: campaign.contacts });
        break;
      }
    }
    finishIfDone(db, campaign);
  }
}

/** Keeps the campaign's contact list in sync when one of its calls ends. */
export function campaignCallEnded(db, call, outcome) {
  const campaign = db.get("campaigns", call.campaignId);
  if (!campaign) return;
  const contact = campaign.contacts.find((c) => c.callId === call.id);
  if (contact) {
    const reached = ["completed", "transferred", "caller-hung-up"].includes(outcome);
    const maxAttempts = campaign.maxAttempts || 1;
    if (!reached && (contact.attempts || 1) < maxAttempts) {
      // Busy or no answer: try again later instead of giving up.
      contact.status = "pending";
      contact.retryAt = new Date(Date.now() + (campaign.retryMinutes || 60) * 60e3).toISOString();
      contact.result = `${outcome}: retry ${contact.attempts || 1} of ${maxAttempts - 1}`;
    } else {
      contact.status = reached ? "done" : "failed";
      contact.result = outcome;
    }
  }
  finishIfDone(db, campaign);
}

function finishIfDone(db, campaign) {
  const open = campaign.contacts.some((c) => c.status === "pending" || c.status === "calling");
  db.update("campaigns", campaign.id, {
    contacts: campaign.contacts,
    ...(campaign.status === "running" && !open && { status: "completed", completedAt: new Date().toISOString() }),
  });
}

export function campaignStats(campaign) {
  const by = (s) => campaign.contacts.filter((c) => c.status === s).length;
  return { total: campaign.contacts.length, pending: by("pending"), calling: by("calling"), done: by("done"), failed: by("failed"), skipped: by("skipped") };
}
