# VoiceDesk Voice API

Programmable phone calls on **VoiceDesk Network** (our own telephony), for developers. The same
idea as Twilio's or Plivo's voice APIs, made in India, with an AI receptionist built in.

Base URL: `https://YOUR-DOMAIN/api/v1/voice` · Auth: `Authorization: Bearer vd_live_…`
(create a key in Dashboard → Developers).

## Place a call

```bash
curl -X POST https://YOUR-DOMAIN/api/v1/voice/calls \
  -H "Authorization: Bearer vd_live_xxx" -H "Content-Type: application/json" \
  -d '{
    "to": "+919811000001",
    "record": true,
    "status_callback": "https://your.app/voice/status",
    "flow": [
      { "say": "Your order 1042 is ready for pickup." },
      { "gather": {
          "numDigits": 1, "timeout": 5,
          "prompt": [{ "say": "Press 1 to talk to the shop, or 2 to end." }],
          "options": {
            "1": [{ "say": "Connecting you now." }, { "dial": { "number": "+919845000001" } }],
            "2": [{ "say": "Goodbye." }]
          } } },
      { "hangup": true }
    ]
  }'
```

`from` is optional (your first VoiceDesk Network number is used). Instead of `flow` you can send
`answer_url`: VoiceDesk POSTs `{call_id, direction, from, to, event: "call.answered"}` to it when
the call is answered, and your server replies with the flow (a JSON list, or `{ "flow": [...] }`).

## Flow steps

| Step | Example | What it does |
|---|---|---|
| `say` | `{ "say": "Hello", "language": "hi-IN", "voice": "anushka" }` | Speaks in VoiceDesk's voice engine (Sarvam, ElevenLabs, Deepgram or your own voice server) |
| `play` | `{ "play": "https://your.app/hold.wav" }` | Plays a WAV file |
| `pause` | `{ "pause": 2 }` | Waits (seconds) |
| `gather` | `{ "gather": { "numDigits": 4, "finishOnKey": "#", "timeout": 5, "input": "dtmf", "prompt": [...], "options": {"1": [...]}, "noInput": [...], "action": "https://…" } }` | Collects keypad digits (or speech with `"input": "speech"`). Branches with `options`, or POSTs `{digits}` / `{speech}` to `action`, which returns the next flow |
| `dial` | `{ "dial": { "number": "+919845000001", "action": "https://…" } }` | Calls another number and joins the two calls. The flow continues when that call ends (`action` gets `{dial_status}`) |
| `record` | `{ "record": { "maxSeconds": 60, "finishOnKey": "#", "action": "https://…" } }` | Records the caller (voicemail). `action` gets `{recording_id, recording_seconds, finished_by}` |
| `ai` | `{ "ai": { "agentId": "optional" } }` | Hands the call to your AI receptionist (bookings, orders, FAQs, transfers…) |
| `redirect` | `{ "redirect": "https://…" }` | Fetches a new flow from your server |
| `hangup` | `{ "hangup": true }` | Ends the call. A flow that runs out also ends the call |

Limits: 200 steps and 25 URL fetches per call; nesting up to 4 levels.

## Incoming calls to your own app

```bash
curl -X PATCH https://YOUR-DOMAIN/api/v1/voice/numbers/NUMBER_ID \
  -H "Authorization: Bearer vd_live_xxx" -H "Content-Type: application/json" \
  -d '{ "voice_url": "https://your.app/voice/answer", "status_callback": "https://your.app/voice/status", "record": true }'
```

Calls to that number now ask your `voice_url` for a flow. Send `"voice_url": null` to give the
number back to the AI receptionist. `GET /numbers` lists your numbers.

## Call details, recordings, usage

- `GET /calls/:id` → `status` (ringing / in-progress / completed), `outcome` (completed, busy,
  no-answer, caller-hung-up, failed), `talk_seconds`, `billed_minutes`, `cost_inr`, `recording`,
  and the flow's `events` (each step, dial results, errors)
- `POST /calls/:id/hangup`
- `GET /recordings/:id` → WAV (both sides of the call, or the voicemail)
- `GET /usage?month=2026-11` → calls, minutes and cost, inbound and outbound

The `status_callback` receives `{ "event": "call.completed", "call": { …same as GET /calls/:id… } }`.

## Billing

Answered time is rounded up to whole minutes. Prices per minute are set by the platform owner
with `VOICE_RATE_INBOUND_PAISE` (default 40 = ₹0.40) and `VOICE_RATE_OUTBOUND_PAISE`
(default 60 = ₹0.60).

## Rules

- Calls only go out from your own VoiceDesk Network numbers; numbers on your do-not-call list are refused.
- Your URLs must be public `https://` addresses (VoiceDesk never calls private network addresses).
- Outbound calling in India must follow TRAI rules (DLT, calling hours, consent). You are
  responsible for the calls your flows make.
