# VoiceDesk voice engine: requirements and status

*November 2026.* VoiceDesk runs **its own voice pipeline**. The phone company only carries the
call audio; VoiceDesk listens, thinks and speaks itself. So a business can use Twilio,
Plivo, Vobiz or Exotel (or several at once) and switch without changing anything else.

```
caller ──phone company──▶ audio stream (WebSocket) ──▶ ears: speech-to-text
                                                          │ text
                                                          ▼
caller ◀──phone company── audio stream ◀── mouth: text-to-speech ◀── brain: Claude + business tools
```

## Requirements gathered

| # | Requirement | How it's met | Status |
|---|---|---|---|
| R1 | Not tied to one phone company | Adapters for Twilio, Plivo, Vobiz, Exotel in `server/voice/carriers.js` | Built, tested against simulated companies |
| R2 | "Our own voice", not the phone company's built-in voice | Pipeline in `server/voice/session.js`; mouth is chosen by VoiceDesk | Built |
| R3 | Indian languages sound natural | Sarvam ears + Bulbul voices picked automatically for Indian languages | Built; **needs a native-speaker listening test** |
| R4 | A voice that belongs to the company | "Your own voice server": any HTTP TTS you host (open-source model on your GPU, or a trained/cloned voice) | Built; the server itself is yours to run |
| R5 | Fast, natural conversation | Replies streamed sentence by sentence; caller can interrupt (barge-in) | Built; **real latency needs live calls** |
| R6 | Incoming and outgoing calls | Answer URLs per number; outbound AI calls, campaigns, callbacks, click-to-call through the business's own number | Built |
| R7 | Transfer to a person | Through each company's API (Exotel: the flow's next Connect applet) | Built |
| R8 | Test without a phone | "Talk in the browser" uses the same pipeline; with no keys, the browser's own speech is used | Built, checked in Chromium |
| R9 | Keys and logins kept safe | Stored on the business, never returned (last 4 characters only); URLs carry secret tokens | Built, tested |
| R10 | One app for setup | Dashboard → **Phone & voice** | Built |

## What I need from you (to go live)

1. **Pick your phone company** (one is enough to start). For India, Exotel, Plivo or Vobiz are
   usually cheaper and better at Indian numbers than Twilio. Open an account and complete their
   **KYC** (business documents; this is required by Indian rules and can take days).
2. **Buy one phone number** from that company (a virtual landline or a toll-free number).
3. **Choose your ears and mouth** and create accounts:
   - Indian languages: **Sarvam** (one key for both ears and voice).
   - English: **Deepgram** (ears) and **ElevenLabs** or Deepgram Aura (voice).
   - Or later: your own voice server (needs a GPU machine; we can plan this together).
4. **Anthropic API key** for the AI brain.
5. **A server with a public HTTPS address** (`PUBLIC_URL`). Phone companies must reach it.
6. Tell me **which languages matter most**, so we test those first with native speakers.

Never paste keys into the chat. Add them in **Phone & voice**, or ask me and I'll open a secure form.

## Setting up each phone company

| Company | Where to paste VoiceDesk's URL |
|---|---|
| Twilio | Phone Numbers → your number → Voice → "A call comes in" → Webhook (POST) → **Answer URL** |
| Plivo | Voice → Applications → XML application → Answer URL (POST) → **Answer URL**; link the number |
| Vobiz | Applications → Answer URL (POST) → **Answer URL**; link the number |
| Exotel | App Bazaar → new flow: **Voicebot** applet with the **Stream URL** → **Connect** applet to your team → Hangup. Assign the ExoPhone to the flow. For outbound calls, enter that flow's App ID in Phone & voice. |

## Honest status

Everything above is covered by automated tests that speak each company's stream protocol and
each engine's API against stand-ins, plus a browser check. **None of it has run on a real phone
call yet.** Protocol details were taken from each company's public documentation in November
2026. Some details differ between their own pages (Exotel's default audio format, Vobiz
parameter names, Sarvam's streaming message shape), so the first live call on each company may
need small adjustments. Exotel's audio format can be switched (16-bit PCM or μ-law) in Settings.

Sources: [Exotel Voicebot applet](https://developer.exotel.com/docs/agentstream/stream-voicebot-applet),
[Exotel WebSocket protocol](https://developer.exotel.com/docs/agentstream/websocket-protocol),
[Plivo audio streaming](https://plivo.com/docs/voice/audio-streaming/audio-streaming),
[Vobiz streams](https://www.vobiz.ai/docs/xml/stream/initiate),
[Sarvam realtime STT](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming),
[Sarvam streaming TTS](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/web-socket).
