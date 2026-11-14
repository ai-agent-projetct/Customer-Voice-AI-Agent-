// The agent's "brain": takes what the caller just said, asks Claude what to
// reply (letting it use tools like booking), and returns text to speak.
import { normalizeServices } from "./catalog.js";
import { customerContext } from "./customers.js";
import { agentLanguages, detectLanguage, greetingIn, lang as langOf, phrase } from "./languages.js";
import { Anthropic, EFFORT, MODEL, aiEnabled, createMessage } from "./llm.js";
import { freeSlots, runTool, switchLanguage, toolDefinitions } from "./tools.js";
import { addDays, toMinutes, todayIn } from "./util.js";

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
  const booking = demoBooking(db, agent, call, userText, text);
  if (booking) return booking;
  const faq = (agent.faqs || []).find((f) => sharesKeyword(f.q, text));
  if (faq) return { reply: faq.a };
  const services = normalizeServices(agent.services);
  if (/price|cost|how much|rate|charge|fee|kitna|कितना|विलை|விலை|எவ்வளவு/.test(text)) {
    const named = services.find((sv) => text.includes(sv.name.toLowerCase()) && sv.price);
    if (named) return { reply: `${named.name} is ${spokenRupees(named.price)}. Would you like to book it?` };
    const priced = services.filter((sv) => sv.price).slice(0, 4);
    if (priced.length) return { reply: `${priced.map((sv) => `${sv.name} is ${spokenRupees(sv.price)}`).join(", ")}. Would you like to book something?` };
  }
  if (/timing|open|close|hours|what time|समय|टाइम|நேரம்|திறந்த/.test(text)) {
    const h = agent.hours;
    return { reply: `We're open ${dayRange(h.days)}, from ${spokenTime(h.open)} to ${spokenTime(h.close)}. Would you like to book a visit?` };
  }
  if (text.includes("?")) {
    runTool(db, agent, call, "note_unanswered_question", { question: userText });
    return { reply: "I'm sorry, I don't have that information right now. I've noted your question for the owner, and they'll get back to you. Anything else I can help with?" };
  }
  return { reply: `I can help with prices, timings and bookings${agent.bookingEnabled ? "" : " questions"}. What would you like to do?` };
}

// ---------- demo-mode helpers: a scripted receptionist that uses real business data ----------

const STOP = new Set(["what", "when", "where", "which", "your", "have", "does", "with", "there", "this", "that", "from", "will", "about", "please", "could", "would", "there"]);
function sharesKeyword(question, text) {
  const words = (s) => s.toLowerCase().match(/[\p{L}]{4,}/gu)?.filter((w) => !STOP.has(w)) ?? [];
  const asked = new Set(words(text));
  return words(question).some((w) => asked.has(w));
}

function spokenRupees(n) {
  return `${Number(n).toLocaleString("en-IN")} rupees`;
}

function spokenTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const hour = ((h + 11) % 12) + 1;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

function dayRange(days) {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const sorted = [...days].sort();
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  return contiguous && sorted.length > 2 ? `${names[sorted[0]]} to ${names[sorted.at(-1)]}` : sorted.map((d) => names[d]).join(", ");
}

function humanDate(date, today) {
  if (date === today) return "today";
  if (date === addDays(today, 1)) return "tomorrow";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

/** Pulls service, day, time, name and phone out of what the caller said. */
function readBookingDetails(agent, text, today) {
  const found = {};
  const service = normalizeServices(agent.services).find((sv) => text.includes(sv.name.toLowerCase()));
  if (service) found.service = service.name;
  if (/\b(today|aaj)\b|आज|இன்று/.test(text)) found.date = today;
  if (/\b(tomorrow|kal)\b|कल|நாளை/.test(text)) found.date = addDays(today, 1);
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const named = days.findIndex((d) => text.includes(d));
  if (named >= 0) {
    let d = addDays(today, 1);
    while (new Date(`${d}T12:00:00Z`).getUTCDay() !== named) d = addDays(d, 1);
    found.date = d;
  }
  const t = text.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|baje|o'?clock)?\b/);
  if (t && Number(t[1]) >= 1 && Number(t[1]) <= 12 && !/\d{5,}/.test(text.replace(/\s/g, ""))) {
    let h = Number(t[1]);
    if (t[3] === "pm" || (!t[3] || t[3] !== "am") && h <= 7) h = h === 12 ? 12 : h + 12;
    if (t[3] === "am" && h === 12) h = 0;
    found.time = `${String(h).padStart(2, "0")}:${t[2] || "00"}`;
  } else if (/evening|shaam|शाम|மாலை/.test(text)) found.time = "17:00";
  else if (/morning|subah|सुबह|காலை/.test(text)) found.time = "10:00";
  const name = text.match(/(?:my name is|this is|i am|i'm|naam|name)\s+([a-z\u0900-\u0DFF]+)/i);
  if (name && !["calling", "looking", "interested", "free"].includes(name[1])) found.name = name[1][0].toUpperCase() + name[1].slice(1);
  const digits = text.replace(/[^\d]/g, "");
  if (digits.length >= 10) found.phone = digits.slice(-10);
  return found;
}

/** A small booking conversation: gathers details, offers free slots, confirms, books. */
function demoBooking(db, agent, call, userText, text) {
  if (!agent.bookingEnabled) return null;
  const today = todayIn(agent.timeZone);
  const state = (call.demo ??= {});
  const starting = /book|appointment|slot|reserve|अपॉइंटमेंट|बुक|அப்பாயின்ட்மென்ட்|புக்/.test(text);
  if (!state.booking && !starting) return null;
  state.booking = true;
  const customer = call.customerId ? db.get("customers", call.customerId) : null;
  Object.assign(state, readBookingDetails(agent, text, today));
  state.name ??= customer?.name || undefined;
  state.phone ??= call.callerNumber || undefined;
  const services = normalizeServices(agent.services);

  if (state.confirming) {
    if (/\b(yes|yeah|yep|ok|okay|sure|haan|ha|confirm)\b|हाँ|ठीक|சரி|ஆமா/.test(text)) {
      const out = runTool(db, agent, call, "book_appointment", {
        customer_name: state.name, phone: state.phone, date: state.date, time: state.time, service: state.service, notes: "",
      });
      const ref = out.result.match(/Reference (\w+)/)?.[1];
      call.demo = {};
      if (!ref) return { reply: `Sorry, that slot was just taken. ${out.result}` };
      return { reply: `Done! Your ${state.service.toLowerCase()} is booked for ${humanDate(state.date, today)} at ${spokenTime(state.time)}. Your reference is ${ref.split("").join(" ")}. You'll get a confirmation message too. Anything else?` };
    }
    if (/\b(no|nahi|change)\b|नहीं|இல்லை/.test(text)) {
      state.confirming = false;
      state.time = undefined;
      return { reply: "No problem. Which time would suit you better?" };
    }
  }
  if (!state.service && services.length) {
    state.service = services.length === 1 ? services[0].name : undefined;
    if (!state.service) return { reply: `Sure! Which service would you like: ${services.slice(0, 4).map((sv) => sv.name).join(", ")}?` };
  }
  if (!state.date) return { reply: `Which day would you like to come in for the ${state.service}?` };
  const free = freeSlots(db, agent, state.date);
  const day = humanDate(state.date, today);
  if (!free.length) {
    state.date = undefined;
    return { reply: `Sorry, we're closed or fully booked ${day}. Would another day work?` };
  }
  if (!state.time || !free.includes(state.time)) {
    const near = state.time ? free.filter((t) => Math.abs(toMinutes(t) - toMinutes(state.time)) <= 120).slice(0, 3) : [];
    const options = (near.length ? near : free.slice(0, 3)).map(spokenTime).join(", ");
    const reply = state.time
      ? `${spokenTime(state.time)} isn't free ${day}, but ${options} ${near.length === 1 ? "is" : "are"} available. Which works for you?`
      : `For ${day} I have ${options} free. Which time works for you?`;
    state.time = undefined;
    return { reply };
  }
  if (!state.name) return { reply: "May I have your name, please?" };
  if (!state.phone) return { reply: `Thanks, ${state.name}. And your 10-digit phone number?` };
  state.confirming = true;
  return { reply: `Let me confirm: ${state.service.toLowerCase()}, ${humanDate(state.date, today)} at ${spokenTime(state.time)}, for ${state.name}${call.callerNumber ? " on this number" : `, phone ${state.phone.split("").join(" ")}`}. Shall I book it?` };
}
