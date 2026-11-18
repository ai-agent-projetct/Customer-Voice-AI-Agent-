# VoiceDesk Network: our own telephony

*November 2026.* VoiceDesk now has its own phone engine. It speaks the phone network's
language (SIP for call setup, RTP for audio) directly, so calls go

```
caller's phone ─▶ Indian operator (Tata Tele / Airtel / Jio / Vi) ─SIP trunk─▶ VoiceDesk ─▶ AI voice pipeline
```

with **no Twilio, Plivo, Vobiz or Exotel in between**. Those companies are still supported as
options (Settings → Phone & voice), but they are not needed.

## How the big platforms are built, and what we built

Programmable voice platforms (Twilio, Plivo, Vobiz, Exotel) all have the same layers:

| Layer | Typical open-source parts | VoiceDesk |
|---|---|---|
| Connection to phone numbers | SIP trunk from a licensed operator | Same (we connect to an operator's trunk) |
| SIP signalling (ring, answer, hang up) | Kamailio / OpenSIPS / drachtio | **Own SIP stack** in `server/sip/ua.js` |
| Media (audio packets, codecs, keypad) | FreeSWITCH / rtpengine | **Own RTP engine** in `server/sip/rtp.js` (G.711 μ-law and A-law, RFC 4733 keypad) |
| Speech in/out | Speech vendors | Deepgram, Sarvam, ElevenLabs or your own voice server |
| Call logic and API | Their own | VoiceDesk's AI receptionist, REST API and webhooks |

Our stack is written in Node.js with no extra telephony software. That makes it simple to run
for a pilot. For thousands of simultaneous calls, the usual next step is to put Kamailio (SIP)
and rtpengine (audio) in front, keeping VoiceDesk's logic unchanged.

## What the engine does

- Answers calls from the operator: 100 Trying, 180 Ringing, 200 OK with audio negotiation (SDP)
- Places calls: INVITE with **digest login** to the operator, caller ID set to the business's number
- **Registers** with the operator if they require it (`SIP_TRUNK_REGISTER=1`)
- Audio at an exact 20 ms pace, μ-law or A-law (Indian operators commonly use A-law)
- Keypad presses (RFC 4733 events and SIP INFO) → language switch
- Barge-in: when the caller talks over the AI, queued audio is dropped at once
- **Transfer to a person**: VoiceDesk dials the team and joins the two calls' audio (it acts as a B2BUA)
- CANCEL of a ringing call, busy / no-answer outcomes, retransmissions over UDP
- **Toll-fraud protection**: only the operator's IP addresses (`SIP_ALLOWED_IPS`) can send calls in

## How it was verified

1. **Automated tests** (`test/sip.test.js`, 9 tests): message parsing, digest login, SDP, RTP,
   keypad, incoming and outgoing calls, transfer with audio flowing between both calls,
   cancelled calls, busy calls, refusal of unknown numbers and strangers' servers.
2. **A real, independent SIP phone (baresip 1.0)** called VoiceDesk and VoiceDesk called it:
   - phone → VoiceDesk: 100 Trying, 180 Ringing, call established, the phone heard VoiceDesk's
     greeting and reply, and hanging up closed the call record
   - VoiceDesk → phone: rang, auto-answered, audio both ways, hung up cleanly
3. **Not yet verified:** a real operator trunk. Every operator has small differences (number
   format, A-law vs μ-law, NAT, re-INVITE timers), so the first live trunk test may need
   adjustments. `SIP_DEBUG=1` prints every SIP message to help.

## Indian rules (important)

From public sources (not legal advice): connecting internet calls to the normal phone network
in India is limited to **licensed telecom operators**. Platforms such as Exotel hold a
**Unified License – Virtual Network Operator (ULVNO)**; others use operators' licences. So:

1. **Now:** buy a **SIP trunk** with Indian numbers (DIDs) from a licensed operator (Tata Tele
   Business Services, Airtel, Jio, Vi) for your company, with KYC. VoiceDesk connects to it.
2. **Outbound calling:** follow TRAI rules: DLT registration, 140-series numbers for
   promotional calls, the 9am–9pm window and do-not-call checks (VoiceDesk already enforces
   consent, hours and DNC).
3. **Later, to resell numbers to many businesses as a platform:** talk to a telecom lawyer about
   a ULVNO licence.

Sources: [Ozonetel: VoIP regulations in India](https://ozonetel.com/voip-in-india/),
[TeleCMI: is VoIP legal in India](https://www.telecmi.com/blog/voip-legal-in-india),
[FreJun: CPaaS providers in India](https://frejun.com/cpaas-providers-india/),
[jambonz open-source components](https://docs.jambonz.org/open-source/commitment/oss-we-use/).

## Going live on VoiceDesk Network

1. Get a SIP trunk from an operator. Ask for: SIP over UDP, G.711 A-law/μ-law, RFC 2833/4733 DTMF,
   static IP authentication or username/password, and a block of DIDs.
2. Rent a server with a **public static IP** (any Indian cloud region) and open:
   UDP 5060 (SIP) from the operator's IPs only, and UDP 10000–20000 (audio).
3. Set the environment variables (see `.env.example`, "VoiceDesk Network"), with `SIP_ENABLED=1`.
4. In the dashboard: **Admin → VoiceDesk Network numbers** → give a number to a business.
5. Call the number from your mobile.
