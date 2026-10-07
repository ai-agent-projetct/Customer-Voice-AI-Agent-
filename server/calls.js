// Call lifecycle shared by phone, browser tests, the website widget,
// campaigns and the Test Lab.
import { greetingFor } from "./agent.js";
import { analyzeCall } from "./analysis.js";
import { campaignCallEnded } from "./campaigns.js";
import { recordCall, upsertCustomer } from "./customers.js";
import { agentLanguages } from "./languages.js";

/**
 * extra: { channel: "phone"|"web"|"widget"|"simulation", direction?, callerNumber?,
 *          campaignId?, greeting?, language? }
 * The call's language is: an explicit choice, else the returning caller's
 * preferred language, else the receptionist's main language.
 */
export function startCall(db, agent, extra) {
  let customer = null;
  if (extra.callerNumber) {
    customer = upsertCustomer(db, agent.orgId, extra.callerNumber);
    if (customer) customer = recordCall(db, customer);
  }
  const spoken = agentLanguages(agent);
  const language = [extra.language, customer?.preferredLanguage].find((c) => c && spoken.includes(c)) ?? agent.language;
  const orgName = db.get("orgs", agent.orgId)?.name;
  const greeting = extra.greeting ?? greetingFor(agent, customer, language, orgName);
  return db.insert("calls", {
    orgId: agent.orgId,
    agentId: agent.id,
    agentName: agent.name,
    direction: "inbound",
    status: "live",
    customerId: customer?.id ?? null,
    transcript: [{ role: "agent", text: greeting, at: new Date().toISOString() }],
    messages: [],
    summary: "",
    durationSec: 0,
    ...extra,
    language,
    languageLog: [{ code: language, reason: "start", turn: 0, at: new Date().toISOString() }],
    greeting,
  });
}

/** Ends a call once, then runs the post-call analysis in the background. */
export function endCall(db, call, outcome, durationSec) {
  const current = db.get("calls", call.id);
  if (!current) return null;
  if (current.status === "ended") {
    if (durationSec) db.update("calls", call.id, { durationSec });
    return null;
  }
  const started = new Date(current.createdAt).getTime();
  const ended = db.update("calls", call.id, {
    status: "ended",
    outcome,
    endedAt: new Date().toISOString(),
    durationSec: durationSec ?? Math.round((Date.now() - started) / 1000),
  });
  if (ended.campaignId) campaignCallEnded(db, ended, outcome);
  if (ended.channel === "simulation") return null;
  return analyzeCall(db, ended).catch((err) => console.error("analysis error", err));
}
