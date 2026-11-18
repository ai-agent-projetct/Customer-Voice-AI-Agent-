// Fills a fresh database with a demo business so every screen has realistic
// data: two weeks of calls in English, Hindi and Tamil, bookings, leads,
// customers, questions to teach, alerts, messages and a finished campaign.
//
//   npm run demo          → seeds data/demo.json and starts the server
//   Log in as demo@voicedesk.in / demo1234
//
// All names and numbers are made up. Nothing is sent anywhere.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../server/auth.js";
import { DEFAULT_HOURS, TEMPLATES } from "../server/catalog.js";
import { Store } from "../server/db.js";
import { addDays, todayIn } from "../server/util.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.DATA_FILE || path.join(here, "..", "data", "demo.json");
const TZ = "Asia/Kolkata";

export const DEMO_LOGIN = { email: "demo@voicedesk.in", password: "demo1234" };

// Small deterministic random generator, so every demo looks the same.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (list) => list[Math.floor(rand() * list.length)];

/** An ISO timestamp for a local India time `daysAgo` days back. */
function at(daysAgo, hhmm) {
  const date = addDays(todayIn(TZ), -daysAgo);
  return new Date(`${date}T${hhmm}:00+05:30`).toISOString();
}

const PEOPLE = [
  ["Rahul Sharma", "+919876500101", "hi-IN"], ["Priya Iyer", "+919876500102", "ta-IN"], ["Ananya Rao", "+919876500103", "en-IN"],
  ["Meena Krishnan", "+919876500104", "ta-IN"], ["Arjun Mehta", "+919876500105", "en-IN"], ["Kavya Nair", "+919876500106", "en-IN"],
  ["Sanjay Gupta", "+919876500107", "hi-IN"], ["Divya Raman", "+919876500108", "ta-IN"], ["Farhan Ali", "+919876500109", "hi-IN"],
  ["Lakshmi Sundar", "+919876500110", "ta-IN"], ["Neha Verma", "+919876500111", "hi-IN"], ["Vikram Reddy", "+919876500112", "en-IN"],
];

// Conversation scripts: [language, intent, sentiment, leadScore, service|null, transcript lines (agent first)]
const SCRIPTS = [
  ["en-IN", "booking", "positive", "hot", "Haircut", [
    "Hi! Thanks for calling Glow Salon. Would you like to book an appointment?",
    "Yes, a haircut tomorrow evening please.",
    "Tomorrow I have 5 PM and 6:30 PM free. Which works for you?",
    "5 PM is good.",
    "Let me confirm: haircut, tomorrow at 5 PM, on this number. Shall I book it?",
    "Yes please.",
    "Done! You'll get a WhatsApp confirmation. See you tomorrow!",
  ]],
  ["hi-IN", "booking", "positive", "hot", "Hair colour", [
    "नमस्ते! Glow Salon में कॉल करने के लिए धन्यवाद। मैं आपकी क्या मदद कर सकती हूँ?",
    "Hair colour karwana hai, kitna charge hai?",
    "Hair colour 1,500 रुपये से शुरू होता है। क्या मैं आपके लिए slot बुक कर दूँ?",
    "Haan, Saturday morning.",
    "Saturday सुबह 10 बजे और 11 बजे खाली है। कौन सा ठीक रहेगा?",
    "11 baje.",
    "बुक हो गया! आपको WhatsApp पर confirmation मिल जाएगा। धन्यवाद!",
  ]],
  ["ta-IN", "booking", "positive", "hot", "Facial", [
    "வணக்கம்! Glow Salon-ஐ அழைத்ததற்கு நன்றி. நான் உங்களுக்கு எப்படி உதவலாம்?",
    "Facial-க்கு appointment வேண்டும், நாளை மாலை.",
    "நாளை மாலை 5 மணி மற்றும் 6 மணி இருக்கிறது. எது வசதி?",
    "6 மணி.",
    "புக் செய்துவிட்டேன்! WhatsApp-ல் உறுதிப்படுத்தல் வரும். நன்றி!",
  ]],
  ["en-IN", "enquiry", "neutral", "warm", null, [
    "Hi! Thanks for calling Glow Salon. Would you like to book an appointment?",
    "Do you have bridal packages?",
    "We do bridal consultations to plan your look and price. Shall I take your details so our stylist calls you?",
    "Yes, my wedding is in March.",
    "Lovely! I've saved your details, and our bridal stylist will call you today.",
  ]],
  ["en-IN", "enquiry", "neutral", "none", null, [
    "Hi! Thanks for calling Glow Salon. Would you like to book an appointment?",
    "What are your timings on Saturday?",
    "We're open Monday to Saturday, 9 AM to 6 PM. Would you like to book a visit?",
    "Not now, thanks.",
    "No problem. Have a great day!",
  ]],
  ["hi-IN", "reschedule_or_cancel", "neutral", "none", null, [
    "नमस्ते! Glow Salon में कॉल करने के लिए धन्यवाद। मैं आपकी क्या मदद कर सकती हूँ?",
    "Mera appointment kal ka hai, usko Friday kar do.",
    "ज़रूर। Friday को 4 बजे खाली है, क्या चलेगा?",
    "Haan theek hai.",
    "आपका appointment Friday 4 बजे कर दिया है। धन्यवाद!",
  ]],
  ["en-IN", "complaint", "negative", "none", null, [
    "Hi! Thanks for calling Glow Salon. Would you like to book an appointment?",
    "I waited 40 minutes past my appointment last week. Not happy.",
    "I'm really sorry about that. I've alerted the owner right away, and she'll call you back today.",
    "Okay.",
  ]],
];

export function seedDemo(target = file) {
  if (fs.existsSync(target)) fs.rmSync(target);
  const db = new Store(target);

  const org = db.insert("orgs", {
    name: "Glow Salon (Demo)", plan: "growth", timeZone: TZ, ownerPhone: "+919800000000",
    followUpChannel: "whatsapp", alertsEnabled: true, briefEnabled: true, briefHour: 20,
    createdAt: at(30, "10:00"),
  });
  db.insert("users", { orgId: org.id, name: "Asha Kumar", email: DEMO_LOGIN.email, passwordHash: hashPassword(DEMO_LOGIN.password), role: "owner" });
  const salon = TEMPLATES.find((t) => t.id === "salon").agent;
  const agent = db.insert("agents", {
    orgId: org.id, ...structuredClone(salon),
    name: "Glow Front Desk",
    greeting: "Hi! Thanks for calling Glow Salon. Would you like to book an appointment?",
    businessInfo: "Glow Unisex Salon, 14 2nd Avenue, Anna Nagar, Chennai (opposite the bus depot). Haircut ₹450, hair colour from ₹1,500, facial ₹800, hair spa ₹900. Bridal packages after a free consultation. UPI, cards and cash accepted.",
    services: [...salon.services, { name: "Hair spa", price: 900 }],
    language: "en-IN", languages: ["hi-IN", "ta-IN"], languageMenu: true, voiceGender: "female", speakingRate: "normal",
    voiceEngine: "standard", greetings: {}, voices: {}, voice: "",
    phoneNumber: "+918000000001", transferNumber: "", hours: structuredClone(DEFAULT_HOURS), timeZone: TZ,
    active: true, widgetEnabled: true, publicId: "demo-glow-salon",
    faqs: [{ q: "Do you have parking?", a: "Yes, free parking for six cars right behind the salon." }],
  });
  const price = Object.fromEntries(agent.services.map((s) => [s.name, s.price]));

  const customers = PEOPLE.map(([name, phone, lang], i) => db.insert("customers", {
    orgId: org.id, name, phone, preferredLanguage: lang, notes: i === 0 ? "Prefers stylist Deepa." : "", calls: 0,
    doNotCall: false, lastCallAt: null, createdAt: at(28 - i, "11:00"),
  }));

  // Two weeks of calls, more on weekends, some after closing time.
  const today = todayIn(TZ);
  for (let daysAgo = 13; daysAgo >= 0; daysAgo--) {
    const count = 2 + Math.floor(rand() * 4);
    for (let n = 0; n < count; n++) {
      const [lang, intent, sentiment, leadScore, service, lines] = pick(SCRIPTS);
      const person = pick(customers.filter((c) => c.preferredLanguage === lang || lang === "en-IN"));
      const afterHours = rand() < 0.25;
      const time = afterHours ? pick(["19:20", "20:45", "21:10", "07:50"]) : pick(["09:40", "11:15", "12:30", "15:05", "16:40", "17:25"]);
      const createdAt = at(daysAgo, time);
      const transcript = lines.map((text, i) => ({ role: i % 2 ? "caller" : "agent", text, at: createdAt }));
      const call = db.insert("calls", {
        orgId: org.id, agentId: agent.id, agentName: agent.name, channel: rand() < 0.15 ? "widget" : "phone", direction: "inbound",
        status: "ended", outcome: "completed", customerId: person.id, callerNumber: person.phone, transcript, messages: [],
        language: lang, languageLog: [{ code: lang, reason: lang === "en-IN" ? "start" : "menu", turn: 0, at: createdAt }],
        greeting: lines[0], durationSec: 45 + Math.floor(rand() * 150), createdAt, endedAt: createdAt,
        summary: "",
        analysis: {
          summary: {
            booking: `${person.name.split(" ")[0]} booked a ${service?.toLowerCase()}.`,
            enquiry: leadScore === "warm" ? `${person.name.split(" ")[0]} asked about bridal packages; wedding in March.` : `${person.name.split(" ")[0]} asked about Saturday timings.`,
            reschedule_or_cancel: `${person.name.split(" ")[0]} moved their appointment to Friday 4 PM.`,
            complaint: `${person.name.split(" ")[0]} complained about a 40-minute wait last week.`,
          }[intent],
          intent, sentiment, leadScore, language: { "en-IN": "English", "hi-IN": "Hindi + English", "ta-IN": "Tamil + English" }[lang],
          followUpNeeded: leadScore === "warm" || sentiment === "negative",
          followUpNote: sentiment === "negative" ? "Call back and apologise; offer a free hair spa." : leadScore === "warm" ? "Call back with bridal packages." : "",
          quality: sentiment === "negative"
            ? { score: 62, accuracy: 4, helpfulness: 3, empathy: 4, resolution: 2, issues: ["Could not resolve the complaint on the call: owner follow-up needed."] }
            : intent === "enquiry" && leadScore === "none"
              ? { score: 78, accuracy: 5, helpfulness: 4, empathy: 4, resolution: 3, issues: ["Caller left without booking: offer a specific slot next time."] }
              : { score: 88 + Math.floor(rand() * 10), accuracy: 5, helpfulness: 5, empathy: 4, resolution: 5, issues: [] },
          extracted: leadScore === "warm" ? { "Occasion": "Wedding in March" } : service ? { "Preferred time": "Evening" } : {},
        },
      });
      db.update("customers", person.id, { calls: (person.calls || 0) + 1, lastCallAt: createdAt });
      person.calls = (person.calls || 0) + 1;

      if (service) {
        const date = addDays(today, 1 - daysAgo); // booked for the day after the call
        db.insert("appointments", {
          orgId: org.id, agentId: agent.id, callId: call.id, ref: Math.floor(rand() * 0xffffff).toString(16).toUpperCase().padStart(6, "0"),
          customerName: person.name, phone: person.phone, date, time: pick(["10:00", "11:00", "15:00", "17:00", "18:00"]),
          service, price: price[service] || 0, notes: "", status: daysAgo > 1 ? pick(["completed", "completed", "completed", "no-show"]) : "confirmed",
          reminded: daysAgo > 1, source: call.channel, createdAt,
        });
        db.insert("messages", { orgId: org.id, to: person.phone, channel: "whatsapp", kind: "booking_confirmed", callId: call.id, status: "demo", createdAt,
          body: `Glow Salon: your ${service} booking is confirmed. Reply or call us to change it.` });
      }
      if (leadScore === "warm") {
        db.insert("leads", { orgId: org.id, agentId: agent.id, callId: call.id, customerName: person.name, phone: person.phone,
          interest: "Bridal package", notes: "Wedding in March", status: daysAgo > 5 ? "contacted" : "new", score: "warm", source: call.channel, createdAt });
      }
      if (sentiment === "negative" && daysAgo < 4) {
        db.insert("alerts", { orgId: org.id, kind: "unhappy_caller", title: "Unhappy caller", body: `${person.name} complained about a long wait. Call back and apologise.`, callId: call.id, urgent: false, seen: false, createdAt });
      }
    }
  }

  // A hot lead and a call happening right now, for the Live calls page.
  const hot = customers[11];
  db.insert("leads", { orgId: org.id, agentId: agent.id, callId: null, customerName: hot.name, phone: hot.phone, interest: "Group booking: 6 people for a wedding", notes: "Wants a package price", status: "new", score: "hot", source: "phone", createdAt: at(0, "10:20") });
  db.insert("alerts", { orgId: org.id, kind: "hot_lead", title: "Hot lead: call them back", body: `${hot.name} wants a group booking for 6 people. ${hot.phone}`, urgent: true, seen: false, createdAt: at(0, "10:22") });
  const now = new Date().toISOString();
  db.insert("calls", {
    orgId: org.id, agentId: agent.id, agentName: agent.name, channel: "phone", direction: "inbound", status: "live", customerId: customers[1].id,
    callerNumber: customers[1].phone, language: "ta-IN", languageLog: [{ code: "ta-IN", reason: "start", turn: 0, at: now }], messages: [], summary: "", durationSec: 0,
    greeting: "Priya, வணக்கம்! Glow Salon-ஐ அழைத்ததற்கு நன்றி.", createdAt: now,
    transcript: [
      { role: "agent", text: "Priya, வணக்கம்! Glow Salon-ஐ அழைத்ததற்கு நன்றி. நான் உங்களுக்கு எப்படி உதவலாம்?", at: now },
      { role: "caller", text: "Hair spa-க்கு இந்த வாரம் slot இருக்கா?", at: now },
      { role: "agent", text: "ஆமாம்! வியாழன் மாலை 4 மணி அல்லது சனிக்கிழமை காலை 11 மணி இருக்கிறது.", at: now },
    ],
  });

  // An order, a callback a caller asked for, and what to capture from calls.
  db.update("agents", agent.id, { ordersEnabled: true, extractFields: [{ name: "Occasion", description: "wedding, party, festival…" }, { name: "Preferred time", description: "morning or evening" }], departments: [{ name: "Bridal desk", number: "+919800000011" }] });
  db.insert("orders", { orgId: org.id, agentId: agent.id, callId: null, ref: "A1B2C3", customerName: customers[3].name, phone: customers[3].phone, items: [{ name: "Hair spa", quantity: 2, price: 900 }], total: 1800, fulfilment: "pickup", address: "", notes: "Gift vouchers", status: "new", source: "phone", createdAt: at(0, "11:05") });
  db.insert("callbacks", { orgId: org.id, agentId: agent.id, phone: customers[6].phone, name: customers[6].name, reason: "Bridal package prices", goal: "", date: addDays(today, 1), time: "11:30", language: "hi-IN", status: "pending", attempts: 0, source: "phone" });

  // ---------- AI workforce: a support colleague, chats on every channel, Brain, approvals ----------
  db.update("agents", agent.id, { role: "receptionist", whatsappEnabled: true, instagramId: "17841400000000001", messengerPageId: "100000000000001", permissions: {}, escalationKeywords: ["lawyer", "consumer court"] });
  const support = db.insert("agents", {
    orgId: org.id, name: "Glow Support", role: "support", language: "en-IN", languages: ["hi-IN", "ta-IN"], greeting: "Hi! Glow Salon support here. How can I help?",
    businessInfo: agent.businessInfo, instructions: "Help with orders of hair-care products, bookings and complaints. Refunds need the owner's approval.",
    services: [{ name: "Hair serum", price: 650 }, { name: "Gift voucher", price: 1000 }], bookingEnabled: false, ordersEnabled: true, whatsappEnabled: false,
    active: true, hours: structuredClone(DEFAULT_HOURS), timeZone: TZ, voiceGender: "female", speakingRate: "normal", voiceEngine: "standard", voiceMode: "standard",
    greetings: {}, voices: {}, voice: "", faqs: [], departments: [], extractFields: [], permissions: { bookings: false }, escalationKeywords: ["lawyer"], publicId: "demo-glow-support",
  });
  const chat = (channel, person, lines, extra = {}) => {
    const createdAt = extra.at || at(0, "10:00");
    return db.insert("calls", {
      orgId: org.id, agentId: extra.agent?.id ?? agent.id, agentName: extra.agent?.name ?? agent.name, channel, direction: "inbound", status: extra.status || "live",
      customerId: person?.id ?? null, callerNumber: channel === "whatsapp" ? person.phone : undefined, externalId: channel === "whatsapp" ? undefined : `${channel.toUpperCase()}-${Math.floor(rand() * 1e9)}`,
      customerName: extra.name || person?.name, language: "en-IN", messages: [], summary: "", durationSec: 0, greeting: lines[0][1], createdAt,
      transcript: lines.map(([role, text, by], i) => ({ role, text, ...(by && { by }), at: new Date(Date.parse(createdAt) + i * 60e3).toISOString() })),
      ...extra.fields,
    });
  };
  chat("whatsapp", customers[2], [
    ["agent", "Hi! I'm the AI assistant for Glow Salon (Demo). How can I help you today?"],
    ["caller", "Do you do keratin treatment? How much?"],
    ["agent", "We don't have keratin on our price list yet, so I've noted your question for the owner. Would you like a hair spa (900 rupees) instead?"],
    ["caller", "I'd like to speak to someone please"],
    ["agent", "Sure! A member of the Glow Salon (Demo) team will reply here shortly."],
  ], { at: at(0, "11:40"), fields: { humanMode: true, humanRequestedAt: at(0, "11:44") } });
  chat("instagram", null, [
    ["agent", "Hi! I'm the AI assistant for Glow Salon (Demo). How can I help you today?"],
    ["caller", "Saw your bridal reel 😍 do you do trials?"],
    ["agent", "Yes! Bridal consultations are free and include a trial plan. Shall I book you a consultation this week?"],
    ["caller", "Saturday morning?"],
    ["agent", "Saturday I have 10 AM and 11 AM free. Which works for you?"],
  ], { name: "@nila.designs", at: at(0, "12:10") });
  chat("messenger", customers[8], [
    ["agent", "Hi! I'm the AI assistant for Glow Salon (Demo). How can I help you today?"],
    ["caller", "My serum order hasn't arrived, it's been a week"],
    ["agent", "Sorry about that! Glow Support will help you from here."],
    ["agent", "Hi Farhan, this is Glow Support. Your order A1B2C3 shipped on Monday with DTDC; tracking says out for delivery today."],
  ], { at: at(0, "09:15"), agent: support, fields: { handoffs: [{ from: agent.name, to: support.name, summary: "Serum order delayed", at: at(0, "09:16") }] } });
  chat("widget", null, [
    ["agent", "Hi! I'm the AI assistant for Glow Salon (Demo). How can I help you today?"],
    ["caller", "is there parking?"],
    ["agent", "Yes, free parking for six cars right behind the salon."],
  ], { name: "Website visitor", at: at(0, "13:02") });

  db.insert("knowledge", { orgId: org.id, title: "Cancellation & refund policy", visibility: "public", source: "upload", addedBy: "Asha Kumar", createdAt: at(10, "10:00"),
    content: "Appointments can be cancelled or moved free of charge up to 4 hours before. Late cancellations are charged 50%. Products can be returned within 7 days if unopened. Damaged products are replaced or refunded after the team checks a photo. Gift vouchers are valid for 12 months and cannot be refunded." });
  db.insert("knowledge", { orgId: org.id, title: "Bridal packages", visibility: "public", source: "upload", addedBy: "Asha Kumar", createdAt: at(9, "10:00"),
    content: "Bridal consultation is free and includes a trial plan. Bridal makeup with hair styling starts at 15,000 rupees; with saree draping and pre-bridal facials 25,000 rupees. We travel to the venue within Chennai for an extra 2,000 rupees. Book at least 4 weeks ahead in wedding season." });
  db.insert("knowledge", { orgId: org.id, title: "Team meeting notes (Monday)", visibility: "internal", source: "note", addedBy: "Asha Kumar", createdAt: at(2, "18:00"),
    content: "Deepa is on leave 20 to 24 November, move her bridal trials to Kavitha. Hair colour supplier is Lakme Distributors, our margin is 32 percent, next order due on the 5th. Diwali offer brought 18 bookings; repeat it for Christmas. Customers keep asking for keratin: get prices by Friday." });

  const refundOrder = db.insert("orders", { orgId: org.id, agentId: support.id, callId: null, ref: "D4E5F6", customerName: customers[8].name, phone: customers[8].phone, items: [{ name: "Hair serum", quantity: 1, price: 650 }], total: 650, fulfilment: "delivery", address: "Anna Nagar", notes: "", status: "delivered", source: "api", createdAt: at(6, "10:00") });
  db.insert("approvals", { orgId: org.id, agentId: support.id, callId: null, kind: "refund", orderId: refundOrder.id, ref: refundOrder.ref, amount: 650, reason: "Bottle arrived leaking; customer sent a photo on Messenger.", phone: customers[8].phone, status: "pending", createdAt: at(0, "09:30") });
  db.insert("orders", { orgId: org.id, agentId: null, callId: null, ref: "COD771", customerName: customers[5].name, phone: customers[5].phone, items: [{ name: "Gift voucher", quantity: 2, price: 1000 }], total: 2000, fulfilment: "delivery", address: "T. Nagar", notes: "", payment: "cod", status: "awaiting_confirmation", consent: true, source: "api", createdAt: at(0, "08:50") });
  db.insert("carts", { orgId: org.id, customerName: customers[9].name, phone: customers[9].phone, items: [{ name: "Hair serum", quantity: 2, price: 650 }], total: 1300, checkoutUrl: "https://shop.example/checkout/demo", consent: true, status: "abandoned", createdAt: at(0, "07:30") });
  db.update("orgs", org.id, { automations: { codConfirm: { enabled: true, messageAfterMinutes: 5, callAfterMinutes: 120 }, abandonedCart: { enabled: true, messageAfterMinutes: 30, callAfterMinutes: 240 }, leadFollowUp: { enabled: true, steps: [{ afterHours: 0, channel: "whatsapp" }, { afterHours: 24, channel: "call" }, { afterHours: 72, channel: "whatsapp" }] } } });
  for (const [who, tool, input, result, h] of [
    [agent, "book_appointment", { service: "Haircut", date: addDays(today, 1), time: "17:00" }, "Booked. Reference 7F3A2C.", "09:05"],
    [agent, "hand_off", { to: support.name }, "Serum order delayed", "09:16"],
    [support, "track_order", { reference: "A1B2C3" }, "Order A1B2C3: 2 × Hair spa, ₹1800, status shipped", "09:17"],
    [support, "request_refund", { reference: "D4E5F6", amount: 650 }, "Refund request sent to the team for approval.", "09:30"],
    [agent, "note_unanswered_question", { question: "Do you do keratin treatment?" }, "Noted for the owner.", "11:41"],
    [agent, "transfer_to_human", { reason: "Customer asked for a person" }, "Handed to the team.", "11:44"],
  ]) db.insert("activity", { orgId: org.id, agentId: who.id, agentName: who.name, callId: null, channel: "whatsapp", tool, input: JSON.stringify(input), result, createdAt: at(0, h) });

  // Questions waiting to be taught.
  for (const [question, count] of [["Do you do home visits for brides?", 4], ["Can I pay with UPI?", 3], ["Do you have a kids' haircut price?", 2]]) {
    db.insert("questions", { orgId: org.id, agentId: agent.id, callId: null, question, status: "open", count, answer: "" });
  }

  // A finished win-back campaign.
  db.insert("campaigns", {
    orgId: org.id, agentId: agent.id, name: "Win-back: Diwali offer", goal: "Invite customers who haven't visited in 60 days back with 15% off before Diwali.",
    openingLine: "We have 15% off all services until Diwali. Would you like to book a visit?", language: "en-IN",
    window: { start: "10:00", end: "19:00", days: [1, 2, 3, 4, 5, 6] }, maxConcurrent: 2,
    consentConfirmed: true, consentConfirmedBy: DEMO_LOGIN.email, consentConfirmedAt: at(9, "10:00"), status: "completed", lastError: "",
    contacts: customers.slice(4, 10).map((c, i) => ({ name: c.name, phone: c.phone, status: i === 3 ? "failed" : "done", result: i === 3 ? "no-answer" : "completed", callId: null })),
    createdAt: at(9, "10:00"), completedAt: at(8, "18:00"),
  });

  db.save();
  return { db, org, agent };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { db } = seedDemo();
  console.log(`Demo data written to ${path.relative(process.cwd(), file)}.`);
  if (process.argv.includes("--start")) {
    const { createApp } = await import("../server/index.js");
    const { startScheduler } = await import("../server/scheduler.js");
    const port = Number(process.env.PORT) || 3000;
    startScheduler(db);
    const { attachRealtime } = await import("../server/realtime.js");
    const server = createApp(db).listen(port, () => {
      console.log(`VoiceDesk demo running at http://localhost:${port}`);
      console.log(`Dashboard: http://localhost:${port}/app  ·  log in as ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`);
    });
    attachRealtime(server, db);
  } else {
    console.log(`Log in at /app as ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`);
  }
}
