// The agent's "brain": takes what the caller just said, asks Claude what to
// reply (letting it use tools like booking), and returns text to speak.
import { normalizeServices } from "./catalog.js";
import { customerContext } from "./customers.js";
import { agentLanguages, detectLanguage, greetingIn, lang as langOf, phrase } from "./languages.js";
import { Anthropic, EFFORT, MODEL, aiEnabled, createMessage } from "./llm.js";
import { runTool, switchLanguage, toolDefinitions } from "./tools.js";
import { todayIn } from "./util.js";

export { aiEnabled };

const MAX_TOOL_ROUNDS = 6;
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function buildSystemPrompt(db, agent, call) {
  const current = langOf(call.language ?? agent.language);
  const spoken = agentLanguages(agent).map((c) => langOf(c).name);
  const org = db.get("orgs", agent.orgId);
  const hours = agent.hours;
  const services = normalizeServices(agent.services)
    .map((s) => (s.price ? `${s.name} (₹${s.price})` : s.name))
    .join(", ");
  const faqs = (agent.faqs || []).map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n\n");
  const customer = call.customerId ? db.get("customers", call.customerId) : null;
  const campaign = call.campaignId ? db.get("campaigns", call.campaignId) : null;

  return [
    campaign
      ? `You are ${agent.name}, an AI assistant phoning a customer on behalf of ${org?.name ?? "this business"}. You placed this call.`
      : `You are ${agent.name}, the AI phone receptionist for ${org?.name ?? "this business"}. You are on a live phone call.`,
    `Today is ${todayIn(agent.timeZone)} (${agent.timeZone}).`,
    `Languages you speak on this call: ${spoken.join(", ")}. The call is currently in ${current.name}: reply in ${current.name}.`,
    "Indian callers often mix languages (Hinglish, Tanglish and so on): mirror the mix they use, keeping the same main language.",
    spoken.length > 1
      ? "If the caller asks for another of your languages, or clearly starts speaking it, use switch_language and continue in that language. If they want a language you don't speak, apologise in their language if you can, and continue in the closest one you speak."
      : `If the caller wants a different language, explain politely that you can only speak ${current.name}, and offer to take a message.`,
    "",
    "How to talk:",
    "- Everything you write is read aloud by a text-to-speech voice. Use plain spoken sentences: no lists, markdown, emojis or URLs.",
    "- Keep each reply to one to three short sentences, then let the caller speak.",
    "- Say numbers, prices and times the way a person would say them.",
    "- Only state facts from the business information and answers below. If you don't know, say so, use note_unanswered_question, and offer to take a message.",
    "- If asked whether you are a person, say honestly that you are the business's AI assistant.",
    "- Before booking, cancelling or rescheduling, read back the details and get a yes.",
    "- If something is urgent (a medical emergency, an angry customer, a big order), use alert_owner. For emergencies, also tell them to call 112 right away.",
    "- When the caller is done, say a short goodbye and use end_call.",
    "",
    `Opening hours: ${hours.days.map((d) => DAY_SHORT[d]).join(", ")}, ${hours.open} to ${hours.close}.`,
    services ? `Services and prices: ${services}.` : "",
    `You already said: "${call.greeting ?? agent.greeting}"`,
    call.callerNumber ? `The other person's phone number is ${call.callerNumber}; confirm it instead of asking for a number.` : "",
    campaign
      ? `\nPurpose of this call: ${campaign.goal}\nIf they are not interested, thank them and end the call. If they ask not to be called again, use do_not_call.`
      : "",
    customer ? `\n<caller_profile>\n${customerContext(db, customer)}\n</caller_profile>` : "",
    "",
    "<business_information>",
    agent.businessInfo || "(none provided)",
    "</business_information>",
    faqs ? `\n<answers_from_owner>\n${faqs}\n</answers_from_owner>` : "",
    "",
    "<owner_instructions>",
    agent.instructions || "(none)",
    "</owner_instructions>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The first thing said on a call, in its language; returning callers are welcomed by name. */
export function greetingFor(agent, customer, code = agent.language, orgName = "") {
  const greeting = greetingIn(agent, code, orgName);
  const first = customer?.name?.trim().split(/\s+/)[0];
  if (!first) return greeting;
  return code.startsWith("en") ? `Welcome back, ${first}! ${greeting}` : `${first}, ${greeting}`;
}

// Text-to-speech engines read symbols literally, so strip formatting.
export function speakable(text) {
  return text.replace(/[*_#`>]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Handle one caller utterance. Mutates `call` (history + transcript) and
 * returns { reply, action } where action is null | {type:"hangup"|"transfer"}.
 */
export async function respond(db, agent, call, userText) {
  call.transcript.push({ role: "caller", text: userText, at: new Date().toISOString() });
  // Caller typed or was transcribed in another of our languages' scripts: follow them.
  const detected = detectLanguage(agent, userText, call.language ?? agent.language);
  if (detected) switchLanguage(db, agent, call, detected, "detected");
  const outcome = aiEnabled() ? await claudeTurn(db, agent, call, userText) : demoTurn(db, agent, call, userText);
  const reply = speakable(outcome.reply) || "Sorry, could you say that again?";
  call.transcript.push({ role: "agent", text: reply, at: new Date().toISOString() });
  if (outcome.action?.summary) call.summary = outcome.action.summary;
  db.update("calls", call.id, {
    transcript: call.transcript,
    messages: call.messages,
    summary: call.summary,
    verifiedRefs: call.verifiedRefs,
    system: call.system,
    promptLanguage: call.promptLanguage,
  });
  return { reply, action: outcome.action ?? null, language: call.language ?? agent.language };
}

async function claudeTurn(db, agent, call, userText) {
  // The history is append-only: Claude's full response content (including
  // thinking blocks) is kept exactly as returned.
  const turnStart = call.messages.length;
  // Built once per call: stable prompts get cached, and rules don't shift mid-call.
  if (!call.system) {
    call.system = buildSystemPrompt(db, agent, call);
    call.promptLanguage = call.language ?? agent.language;
  }
  const language = call.language ?? agent.language;
  if (language !== call.promptLanguage) {
    // The language changed since Claude was last told (menu, detection): say so
    // without touching the cached system prompt.
    const note = `The call is now in ${langOf(language).name}. Reply only in ${langOf(language).name} from now on.`;
    if (supportsMidConversationSystem(MODEL)) {
      call.messages.push({ role: "user", content: userText }, { role: "system", content: note });
    } else {
      call.messages.push({ role: "user", content: `[${note}]\n${userText}` });
    }
  } else {
    call.messages.push({ role: "user", content: userText });
  }
  const system = call.system;
  const org = db.get("orgs", agent.orgId);
  const tools = toolDefinitions(agent, org, call);
  const spoken = [];
  let action = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response;
    try {
      response = await createMessage({
        max_tokens: 4000,
        output_config: { effort: EFFORT },
        cache_control: { type: "ephemeral" }, // reuse the system prompt + tools across turns
        system,
        tools,
        messages: call.messages,
      });
    } catch (error) {
      console.error("Claude request failed:", error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : error);
      call.messages.length = turnStart; // drop this turn so the history stays valid for a retry
      return { reply: "Sorry, I'm having trouble right now. Could you please repeat that?" };
    }

    if (response.stop_reason === "refusal") {
      call.messages.length = turnStart;
      return { reply: "Sorry, I can't help with that. Is there anything else I can do for you?" };
    }

    call.messages.push({ role: "assistant", content: response.content });
    for (const block of response.content) {
      if (block.type === "text") spoken.push(block.text);
    }
    if (response.stop_reason !== "tool_use") break;

    const results = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const out = runTool(db, agent, call, block.name, block.input);
      if (out.action) action = out.action;
      results.push({ type: "tool_result", tool_use_id: block.id, content: out.result });
    }
    call.messages.push({ role: "user", content: results });
    if (action) break; // hanging up or transferring: nothing more to say
  }
  call.promptLanguage = call.language ?? agent.language; // switch_language results told Claude already
  return { reply: spoken.join(" "), action };
}

// Models that accept {role: "system"} entries inside `messages`.
function supportsMidConversationSystem(model) {
  return /opus-5|opus-4-8|fable|mythos|sonnet-5-5/.test(model);
}

// True right after respond() switched language because of the caller's script.
function detectedNow(call) {
  const last = call.languageLog?.at(-1);
  return Boolean(last && last.reason === "detected" && last.turn === call.transcript.length);
}

// Demo brain used when no ANTHROPIC_API_KEY is set, so the whole product can
// be clicked through for free. It is deliberately simple, but it exercises the
// same tools (learning loop, alerts, transfer, opt-out) so every screen fills up.
function demoTurn(db, agent, call, userText) {
  const text = userText.toLowerCase();
  const org = db.get("orgs", agent.orgId);
  const has = (name) => toolDefinitions(agent, org, call).some((t) => t.name === name);
  const current = call.language ?? agent.language;
  if (detectedNow(call)) {
    return { reply: `${phrase(current, "chosen")} ${greetingIn(agent, current, org?.name)}` };
  }
  const asked = agentLanguages(agent).find((code) => code !== current && langOf(code).keywords.some((k) => text.includes(k.toLowerCase())));
  if (asked) {
    switchLanguage(db, agent, call, asked);
    return { reply: phrase(asked, "chosen") };
  }
  if (/\b(don't|do not|dont|never) call\b|\bstop calling\b/.test(text) && has("do_not_call")) {
    runTool(db, agent, call, "do_not_call", { reason: userText });
    return { reply: "Sorry for the trouble. We won't call this number again. Goodbye.", action: { type: "hangup", summary: "Asked not to be called again" } };
  }
  if (/\b(bye|thank you|thanks|that's all)\b/.test(text)) {
    return { reply: "You're welcome. Have a great day, goodbye!", action: { type: "hangup", summary: "Demo call" } };
  }
  if (/\b(emergency|urgent|angry|complaint)\b/.test(text)) {
    runTool(db, agent, call, "alert_owner", { reason: `Caller said: "${userText}"`, urgency: "urgent" });
    return { reply: "I understand, this is important. I've alerted the owner right away and someone will call you back shortly." };
  }
  if (/\b(human|person|manager|owner|staff)\b/.test(text) && has("transfer_to_human")) {
    return { reply: "Sure, connecting you to a member of our team now.", action: { type: "transfer", reason: "Caller asked for a person" } };
  }
  if (/\b(book|appointment|slot|reserve)\b/.test(text) && agent.bookingEnabled) {
    return { reply: "I'd be happy to help you book. Demo mode can't check the calendar; add an Anthropic API key to turn on the real assistant." };
  }
  if (text.includes("?")) {
    runTool(db, agent, call, "note_unanswered_question", { question: userText });
    return { reply: `Demo mode: I've noted your question "${userText}" for the owner. Add an Anthropic API key for real answers.` };
  }
  return { reply: `Demo mode: you said "${userText}". Add an Anthropic API key on the server to get real AI answers.` };
}
