# VoiceDesk: the AI front desk for local businesses

VoiceDesk answers a business's phone calls (and website chats) with an AI receptionist that
books appointments, answers questions, remembers customers, sends WhatsApp follow-ups, and
reports the money it made. It speaks English and 9 Indian languages, including mixed speech
such as Hinglish.

**Read first:**
- [docs/STRATEGY.md](docs/STRATEGY.md): market analysis, positioning and why these features
- [docs/FEATURES.md](docs/FEATURES.md): every feature, which reference product has it, and how far it has been verified
- [docs/LEARN.md](docs/LEARN.md): how voice AI works, how to run it, and how to launch

## What's in the product

| Area | Features |
|---|---|
| **Receptionist** | Industry templates · **AI setup assistant** (from a website link or notes) · services with prices · opening hours · FAQs · 10 languages and code-mixing |
| **Languages & voice** | Speaks **English + 9 Indian languages** on one number · **"choose your language" menu** (each option in its own voice) · **switches language mid-call** when asked, or when the caller speaks or types in another script · **remembers each customer's language** · female/male voices · slower speech for elderly callers · AI-translated greetings · optional **premium natural voices** |
| **On the call** | Book / check / **cancel / reschedule** by voice · save leads · send info on WhatsApp · **alert the owner** · transfer to a person · respects "don't call me" |
| **Gets smarter** | **"Teach it"**: questions it couldn't answer become answers · **caller memory** (greets returning callers by name, knows their bookings) |
| **Quality** | **Readiness Test Lab**: AI role-plays tough callers and an AI examiner scores the receptionist with exact fixes |
| **After the call** | **AI analysis** (summary, intent, mood, hot/warm/cold lead score) · WhatsApp/SMS **confirmations** · **reminders** the day before · hot-lead and unhappy-caller **alerts** |
| **Owner** | **ROI dashboard** (revenue in ₹, after-hours calls caught) · **daily WhatsApp brief** · **live calls with one-tap takeover** · customers · bookings · leads · CSV export · **erase customer data** |
| **Real-time & telephony** | **Real-time mode** (streaming replies, callers can interrupt) · call recording · teams for transfers · **click-to-call** · **scheduled callbacks** · **WhatsApp chat** on the same AI · **order-taking** |
| **Quality** | **Every call scored** (accuracy, helpfulness, empathy, resolution) · common problems · calls to review · **custom details captured** from each call |
| **Developers** | **REST API** with API keys · **signed webhooks** with retries · **speed to lead** (a new lead gets an AI call in seconds) |
| **Own telephony** | **VoiceDesk Network**: VoiceDesk's own SIP + audio engine connects straight to an Indian operator's SIP trunk, with no Twilio/Plivo/Vobiz/Exotel in between · transfer, keypad, A-law/μ-law, toll-fraud protection · see `docs/TELEPHONY-PLATFORM.md` |
| **Own voice engine** | VoiceDesk listens and speaks itself on **any phone company: Twilio, Plivo, Vobiz or Exotel** · ears: Deepgram or Sarvam · voice: ElevenLabs, Sarvam, Deepgram or **your own voice server** · barge-in · talk to your AI in the browser · see `docs/VOICE-ENGINE.md` |
| **AI workforce** | One AI employee on **WhatsApp, Instagram DM, Messenger**, website and phone, remembering each customer across channels · **Inbox with human takeover** · **roles, permissions, escalation words** · **hand-offs between AI employees** · **activity log** · **refund approvals** · **Company Brain** (knowledge vault, ask from WhatsApp) · **automations**: COD confirmation, abandoned carts, lead follow-ups |
| **Growth** | **Outbound campaigns** (win-back, reminders) with consent records, a 9am–9pm calling window, do-not-call and AI disclosure enforced in code · **website voice/chat widget** |
| **Business** | Plans with minute and receptionist limits · a polite hand-off to a person when minutes run out · **platform admin console** · rate limiting · Twilio signature checks |

## See a demo

```bash
npm install
npm run demo
```

This loads **Glow Salon (Demo)**: two weeks of calls in English, Hindi and Tamil, bookings,
leads, customers, questions to teach, a live call and a finished campaign. Then it starts the
server. Open <http://localhost:3000/app> and log in as `demo@voicedesk.in` / `demo1234`.
Each run starts from fresh demo data.

Without an AI key, the receptionist follows a script built from the business's own details:
it answers prices, timings and taught FAQs, and books real free slots. With
`ANTHROPIC_API_KEY` set, the conversations are real AI.

## Run it on your computer

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
cd voice-ai
npm install
npm start
```

Open <http://localhost:3000> for the website and <http://localhost:3000/app> for the dashboard.
Without an API key everything runs in **demo mode** (placeholder replies). To turn on the AI,
phone calls and messaging:

```bash
cp .env.example .env      # fill in the keys you have
npm run dev               # loads .env and restarts when you edit code
```

To see the admin console, put your email in `ADMIN_EMAILS`.

## Tests

```bash
npm test
```

There are 76 end-to-end tests, all running without any paid account. They cover accounts and
data isolation, phone webhooks and signature checks, booking rules, the Claude tool loop and
structured analysis (against a fake API), caller memory, self-service privacy, the teaching
loop, alerts, ROI, briefs, reminders, live takeover, plan limits, campaign compliance, the
widget, the Test Lab, the setup assistant, admin, CSV export and data erasure.

## Project layout

```
server/
  index.js            starts the web server and the background scheduler
  agent.js            the AI brain: system prompt + Claude + tool loop (+ demo brain)
  tools.js            what the receptionist can do on a call, with the business rules
  languages.js        the 10 languages: voices, menu lines, greetings, phrases, script detection
  tts.js              how replies are spoken: standard voices, speed, premium natural voices
  llm.js              Claude client: messages, structured JSON, refusal fallbacks
  calls.js            call lifecycle (start, end, then analysis)
  analysis.js         post-call AI analysis and owner alerts
  customers.js        caller memory, win-back audiences, data erasure
  messaging.js        WhatsApp/SMS outbox and owner notifications
  insights.js         ROI numbers and the daily brief
  scheduler.js        reminders, briefs, stale-call cleanup, campaign dialling
  campaigns.js        outbound campaigns with compliance rules
  simulator.js        Readiness Test Lab
  setup-assistant.js  AI setup from a website link or notes
  plans.js            plans and usage metering
  telephony.js        placing outbound calls via Twilio
  routes/             HTTP API: account, agents, records, growth, public (widget), admin, twilio
public/
  index.html          marketing website
  app.html, js/       dashboard (plain ES modules, no build step)
  widget.js           embeddable "Talk to us" widget
scripts/demo.js       demo business with sample data (npm run demo)
test/                 automated tests
docs/                 STRATEGY.md, LEARN.md
```
