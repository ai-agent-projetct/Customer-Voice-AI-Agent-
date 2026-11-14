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
    createApp(db).listen(port, () => {
      console.log(`VoiceDesk demo running at http://localhost:${port}`);
      console.log(`Dashboard: http://localhost:${port}/app  ·  log in as ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`);
    });
  } else {
    console.log(`Log in at /app as ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`);
  }
}
