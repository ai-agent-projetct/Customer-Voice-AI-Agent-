// After every call: AI writes a summary, the caller's intent, sentiment and a
// lead score. Hot leads and unhappy callers alert the owner.
import { aiEnabled, objectSchema, structured } from "./llm.js";
import { lang } from "./languages.js";
import { notifyOwner } from "./messaging.js";
import { emitEvent } from "./webhooks.js";

const INTENTS = ["booking", "enquiry", "reschedule_or_cancel", "complaint", "sales_lead", "emergency", "wrong_number", "other"];

const BASE = {
  summary: { type: "string", description: "One or two sentences: who called, what they wanted, what happened" },
  intent: { type: "string", enum: INTENTS },
  sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
  lead_score: { type: "string", enum: ["hot", "warm", "cold", "none"], description: "How likely this caller is to buy soon" },
  language: { type: "string", description: "Language(s) the caller used, e.g. 'Hindi + English'" },
  follow_up_needed: { type: "boolean" },
  follow_up_note: { type: "string", description: "What the owner should do next, or empty" },
  // Quality audit of the receptionist on this call (every call is scored).
  quality: objectSchema({
    score: { type: "integer", description: "Overall 0-100" },
    accuracy: { type: "integer", description: "1-5: only stated facts from the business information" },
    helpfulness: { type: "integer", description: "1-5: understood the need and moved it forward" },
    empathy: { type: "integer", description: "1-5: polite, warm, handled emotion well" },
    resolution: { type: "integer", description: "1-5: the caller's need was resolved or correctly handed over" },
    issues: { type: "array", items: { type: "string" }, description: "Specific mistakes, or empty" },
  }),
  extracted: {
    type: "array",
    description: "Values for the owner's custom fields found in the call; leave out fields that were not mentioned",
    items: objectSchema({ name: { type: "string" }, value: { type: "string" } }),
  },
};
const SCHEMA = objectSchema(BASE);

export async function analyzeCall(db, call) {
  if (call.transcript.length < 2) return null;
  const outcomes = {
    booked: db.find("appointments", (a) => a.callId === call.id).length,
    leads: db.find("leads", (l) => l.callId === call.id).length,
  };
  const agent = call.agentId ? db.get("agents", call.agentId) : null;
  const fields = (agent?.extractFields || []).filter((f) => f.name);
  let analysis;
  if (aiEnabled()) {
    try {
      const transcript = call.transcript.map((t) => `${t.role === "agent" ? "Receptionist" : "Caller"}: ${t.text}`).join("\n");
      const a = await structured({
        system: "You review phone calls handled by an AI receptionist for a small business and produce a short, factual report for the owner.",
        prompt: `Bookings made on this call: ${outcomes.booked}. Leads saved: ${outcomes.leads}.\n${fields.length ? `Custom fields to extract: ${fields.map((f) => `${f.name} (${f.description || "as stated by the caller"})`).join("; ")}.\n` : ""}${agent?.businessInfo ? `\n<business_information>\n${agent.businessInfo}\n</business_information>\n` : ""}\n<transcript>\n${transcript}\n</transcript>`,
        schema: SCHEMA,
        effort: "low",
      });
      analysis = {
        summary: a.summary, intent: a.intent, sentiment: a.sentiment, leadScore: a.lead_score,
        language: a.language, followUpNeeded: a.follow_up_needed, followUpNote: a.follow_up_note,
        quality: { ...a.quality, score: Math.max(0, Math.min(100, a.quality.score)) },
        extracted: Object.fromEntries(a.extracted.filter((e) => fields.some((f) => f.name === e.name) && e.value).map((e) => [e.name, e.value])),
      };
    } catch (err) {
      console.error("Call analysis failed:", err.message);
      return null;
    }
  } else {
    analysis = heuristicAnalysis(call, outcomes);
  }

  const fresh = db.get("calls", call.id);
  if (!fresh) return null; // erased meanwhile
  db.update("calls", call.id, { analysis, summary: fresh.summary || analysis.summary });
  db.find("leads", (l) => l.callId === call.id).forEach((l) => db.update("leads", l.id, { score: analysis.leadScore }));

  const who = call.callerNumber || "a website visitor";
  if (analysis.leadScore === "hot" && !outcomes.booked) {
    notifyOwner(db, call.orgId, { kind: "hot_lead", title: "Hot lead: call them back", body: `${analysis.summary}\nFrom ${who}`, callId: call.id, urgent: true });
  } else if (analysis.sentiment === "negative") {
    notifyOwner(db, call.orgId, { kind: "unhappy_caller", title: "Unhappy caller", body: `${analysis.summary}\nFrom ${who}`, callId: call.id });
  }
  emitEvent(db, call.orgId, "call.completed", {
    id: call.id, channel: call.channel, direction: call.direction, phone: call.callerNumber || null, language: fresh.language,
    duration_sec: fresh.durationSec, outcome: fresh.outcome, recording_url: fresh.recordingUrl || null, ...analysis,
  });
  return analysis;
}

// Rough rules for demo mode (no API key).
function heuristicAnalysis(call, outcomes) {
  const said = call.transcript.filter((t) => t.role === "caller").map((t) => t.text.toLowerCase()).join(" ");
  const negative = /\b(angry|worst|bad|complaint|terrible|rude|never again)\b/.test(said);
  const intent = outcomes.booked ? "booking"
    : /\b(emergency|urgent)\b/.test(said) ? "emergency"
    : negative ? "complaint"
    : /\b(cancel|reschedule|change)\b/.test(said) ? "reschedule_or_cancel"
    : /\b(price|cost|buy|interested|rate)\b/.test(said) ? "sales_lead"
    : "enquiry";
  return {
    summary: call.summary || `Caller made a ${intent.replace(/_/g, " ")} over ${call.transcript.length} messages.`,
    intent,
    sentiment: negative ? "negative" : outcomes.booked ? "positive" : "neutral",
    leadScore: outcomes.booked ? "hot" : outcomes.leads ? "warm" : intent === "sales_lead" ? "warm" : "none",
    language: lang(call.language || "en-IN").name,
    followUpNeeded: Boolean(outcomes.leads) || negative,
    followUpNote: negative ? "Call the customer back and apologise." : outcomes.leads ? "Call back about their enquiry." : "",
    quality: demoQuality(call, outcomes, negative),
    extracted: {},
  };
}

// Demo-mode quality score from simple signals; the real audit is done by AI.
function demoQuality(call, outcomes, negative) {
  const unanswered = call.transcript.filter((t) => t.role === "agent" && /don't have that information/.test(t.text)).length;
  const resolution = outcomes.booked ? 5 : outcomes.leads ? 4 : unanswered ? 2 : 3;
  const helpfulness = Math.max(1, 4 - unanswered + (outcomes.booked ? 1 : 0));
  const empathy = negative ? 3 : 4;
  const issues = [];
  if (unanswered) issues.push(`Could not answer ${unanswered} question${unanswered === 1 ? "" : "s"}: teach the answer in "Teach it".`);
  if (negative && !outcomes.booked) issues.push("Caller was unhappy: follow up personally.");
  return { score: Math.round(((4 + helpfulness + empathy + resolution) / 20) * 100), accuracy: 4, helpfulness: Math.min(5, helpfulness), empathy, resolution, issues };
}
