# VoiceDesk feature map and verification status

*Updated November 2026.* This page lists what the reference products offer, what VoiceDesk
has, and **how far each feature has actually been verified**. Keep it honest: update the
status column whenever something is tested against a real service.

## How to read "Verified"

| Level | Meaning |
|---|---|
| **A. Live** | Tested against the real outside service (real phone call, real AI, real audio). |
| **B. Automated** | Covered by automated tests that run the real code path against a stand-in for the outside service (a fake Twilio request, a fake AI server, a WebSocket test client). Logic is proven; the outside service's behaviour is not. |
| **C. Browser** | Clicked through in a real browser (Chromium), no errors. |
| **D. Written only** | Code exists but nothing has exercised it. |

Nothing in this table is at level A yet. Level A needs your own accounts: an Anthropic API
key, a Twilio account with a phone number (plus ConversationRelay access for real-time
mode), a WhatsApp sender, and optionally ElevenLabs. See "Going live" at the end.

## Reference products

Researched from public pages in November 2026 (the sites themselves could not be opened from
the build environment, so this relies on search results of their own pages and docs).

| Product | What it is known for |
|---|---|
| **ZenX AI / ZenVoice** (Chennai) | AI telecalling in Indian languages, instant calls to new leads, CRM with call analysis, HubSpot/Zoho/Salesforce sync, voice API |
| **OmniDimension** | No-code voice agents for calls, web chat and WhatsApp; bulk calls with retries; post-call actions; extracted variables; API, webhooks, CRM integrations |
| **ConvoZen** | Voice agents plus quality audits on 100% of calls, supervisor review, agent assist and coaching |
| **Edesy** | Voice agents in 10+ Indian languages with code-switching, copilot that drafts the agent, REST API and webhooks |
| **SharyX** | AI receptionist, appointment booking, order-taking (OrderAI), call quality scoring (VQI), workflow actions, scheduled callbacks |
| **Tata Smartflo** | Cloud telephony: virtual numbers, multi-level IVR, call recording, click-to-call, auto dialer, number masking |
| **Deepgram** | Speech engine: streaming speech-to-text and text-to-speech, voice agent API with barge-in and mid-call language switching |

## Feature map

| Feature | Seen in | VoiceDesk | Verified |
|---|---|---|---|
| Inbound AI receptionist (answers, books, takes messages) | all | ✅ | B, C |
| Appointment booking, cancel, reschedule with rules in code | SharyX, ZenX | ✅ | B |
| 10 languages on one number, language menu, mid-call switching | Edesy, Deepgram, ZenX | ✅ | B, C |
| Mixed-language speech (Hinglish, Tanglish) | Edesy, Omnidim | ✅ prompt instructs it | D for real speech (needs live AI + STT) |
| **Real-time streaming voice with barge-in** | Deepgram, Omnidim, Edesy | ✅ Twilio ConversationRelay mode | B (WebSocket protocol test); not yet on a live call |
| Natural premium voices | Deepgram, Omnidim | ✅ ElevenLabs option with fallback | B (fake audio); real audio quality unverified |
| Agent drafted from plain text / website ("copilot") | Edesy | ✅ AI setup assistant | B, C (demo extraction); AI path against fake server |
| Test before go-live | (none found) | ✅ Readiness Test Lab | B, C |
| Learns from unanswered questions | (none found) | ✅ Teach it | B, C |
| Caller memory and remembered language | ZenX CRM | ✅ | B, C |
| Call transcripts, summaries, sentiment, lead score | ZenX, Omnidim | ✅ | B, C |
| **Quality audit on 100% of calls** | ConvoZen, SharyX VQI | ✅ Quality page, per-call scorecard | B, C |
| **Custom details captured from each call** | Omnidim (extracted variables) | ✅ per-receptionist fields | B (AI path against fake server) |
| Outbound campaigns from a list | Omnidim, ZenX, Smartflo dialer | ✅ with consent, hours, do-not-call | B, C |
| **Retries for busy / no answer** | Omnidim | ✅ campaigns and one-off calls | B |
| **Speed to lead: instant AI call to a new lead** | ZenX CRM, SharyX | ✅ `POST /api/v1/leads` with `call_now` | B, C |
| **Scheduled callbacks** | SharyX | ✅ "call me back at 5" | B |
| **Developer API and API keys** | Omnidim, Edesy, ZenVoice | ✅ `/api/v1` | B, C |
| **Signed webhooks with retries (CRM, Zapier)** | Omnidim, Edesy | ✅ 6 event types | B, C |
| Native HubSpot / Zoho / Salesforce connectors | ZenX, Omnidim, Edesy | ◐ through webhooks and the API (works with Zapier/Make); no one-click connector yet | n/a |
| **Department routing (replaces IVR menus)** | Smartflo multi-level IVR | ✅ teams | B |
| **Call recording** | Smartflo | ✅ per receptionist | B (TwiML and callback); needs a live call to confirm audio |
| **Click-to-call with the business number shown** | Smartflo | ✅ from a customer's page | B |
| **WhatsApp chat on the same AI** | Omnidim | ✅ inbound WhatsApp webhook | B |
| WhatsApp/SMS confirmations and reminders | SharyX, ZenX | ✅ | B, C |
| **Order-taking by voice** | SharyX OrderAI | ✅ items and totals checked in code | B, C |
| Website voice and chat widget | Omnidim | ✅ | B, C |
| Live call monitoring and takeover ("barge") | Smartflo, ConvoZen supervisor | ✅ | B, C |
| ROI dashboard in rupees, daily owner brief | (none found) | ✅ | B, C |
| Plans, usage limits, admin console | all (as businesses) | ✅ | B, C |
| Data export and erasure | (compliance pages) | ✅ | B |
| Visual drag-and-drop flow builder | Omnidim, Edesy | ❌ by design: owners describe the business in plain language instead | n/a |
| Human agent assist and coaching | ConvoZen | ❌ VoiceDesk targets shops without call-centre staff | n/a |
| Android / iOS app | Smartflo | ❌ the dashboard works on a phone browser; no store app | C (mobile layout) |
| Own speech models, SIP trunks, virtual number inventory | Deepgram, Smartflo | ❌ uses Twilio (or another carrier adapter) | n/a |
| OTP / identity verification calls | SharyX VerifyAI | ❌ | n/a |

## Going live: what you need to reach level A

1. **Anthropic API key** → real AI conversations. Then make test calls in each language you
   plan to sell and have a native speaker judge them.
2. **Twilio account + phone number** → real phone calls (see Settings → Phone setup).
   - Ask Twilio to enable **ConversationRelay** for real-time mode.
   - Set `PUBLIC_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_CALLER_ID`.
3. **WhatsApp sender** in Twilio → real confirmations, reminders and WhatsApp chat.
4. **A hosted server** with HTTPS and a real database (see `LEARN.md`, production checklist).
5. **Native-speaker review** of the built-in phrases in `server/languages.js`.
6. **Legal review** before any outbound calling in India (TRAI, DLT, DND).

Until those are done, VoiceDesk is a tested pilot build, not a production service.
