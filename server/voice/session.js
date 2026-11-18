// VoiceDesk's own voice pipeline for one live call, the same for every phone
// company:
//
//   caller audio ─▶ ears (speech-to-text) ─▶ brain (agent.respond, streamed)
//        ▲                                          │ sentence by sentence
//        └────────── phone company ◀── mouth (text-to-speech) ◀┘
//
// Barge-in: when the caller starts talking over the AI, we tell the phone
// company to drop the audio it has not played yet and stop generating the
// old reply. Silence: after a few quiet stretches the AI asks again, then
// says goodbye. Keypad: 1-9 switch language in the order the receptionist
// speaks them.
import { respond, speakable } from "../agent.js";
import { endCall } from "../calls.js";
import { phrase, pickLanguage } from "../languages.js";
import { switchLanguage } from "../tools.js";
import { publicUrl } from "../telephony.js";
import { FRAME, chunks, durationMs } from "./audio.js";
import { CARRIERS, credsFor } from "./carriers.js";
import { chooseEngines, openStt, synthesize } from "./engines.js";

const SILENCE_MS = () => Number(process.env.VOICE_SILENCE_MS) || 8000;
const MAX_SILENCES = 2;
const SENTENCE_END = /([.!?।॥]+)(\s|$)/;

export class VoiceSession {
  constructor({ db, carrier, send, close, options = {} }) {
    this.db = db;
    this.carrier = CARRIERS[carrier];
    this.carrierId = carrier;
    this.sendRaw = send; // (object) => void
    this.closeSocket = close;
    this.options = options; // e.g. { encoding: "mulaw" } for Exotel
    this.stream = { streamId: null };
    this.turn = 0;
    this.speakingUntil = 0;
    this.playChain = Promise.resolve();
    this.queue = Promise.resolve();
    this.lastHeardAt = Date.now();
    this.silences = 0;
    this.finished = false;
    this.marks = 0;
  }

  get call() { return this.db.get("calls", this.callId); }
  get agent() { return this.call && this.db.get("agents", this.call.agentId); }
  get org() { return this.call && this.db.get("orgs", this.call.orgId); }
  speaking() { return Date.now() < this.speakingUntil; }
  language() { const c = this.call; return c?.language ?? this.agent?.language ?? "en-IN"; }

  /** The phone company's stream is ready and we know which call it is. */
  begin(call, streamId) {
    this.callId = call.id;
    this.stream.streamId = streamId;
    const engines = chooseEngines(this.org, this.language(), this.carrierId);
    this.engines = engines;
    this.db.update("calls", call.id, {
      realtime: true, voicePipeline: "voicedesk", carrier: this.carrierId,
      voiceEngines: { stt: engines.stt, tts: engines.tts }, answeredAt: call.answeredAt || new Date().toISOString(),
    });
    if (!engines.stt || !engines.tts) {
      console.error(`Voice engine not set up for ${this.carrierId} call ${call.id}: missing ${engines.missing.join(", ")}`);
      this.db.update("calls", call.id, { error: `Voice not set up: add ${engines.missing.join(" and ")} in Settings → Phone & voice.` });
      return this.finish("not-configured");
    }
    this.openEars();
    this.say(call.greeting, this.turn);
    this.timer = setInterval(() => this.checkSilence(), 500);
    this.timer.unref?.();
  }

  openEars() {
    this.ears?.close();
    this.earsLanguage = this.language();
    const engines = chooseEngines(this.org, this.earsLanguage, this.carrierId);
    this.engines = engines;
    this.ears = openStt({
      engine: engines.stt,
      org: this.org,
      language: this.earsLanguage,
      onSpeechStart: () => { this.lastHeardAt = Date.now(); },
      onPartial: (text) => {
        this.lastHeardAt = Date.now();
        if (this.speaking() && text.length >= 3) this.interrupt();
      },
      onFinal: (text) => this.heard(text),
      onError: (err) => console.error(`Speech-to-text (${engines.stt}) error:`, err.message),
    });
  }

  audio(pcm) {
    if (!this.finished) this.ears?.write(pcm);
  }

  heard(text) {
    if (this.finished) return;
    this.lastHeardAt = Date.now();
    this.silences = 0;
    if (this.carrierId === "web") this.send({ event: "caption", role: "caller", text });
    if (this.speaking()) this.interrupt();
    const mine = ++this.turn;
    this.queue = this.queue.then(() => this.reply(text, mine)).catch((err) => console.error("voice turn failed", err));
  }

  dtmf(digit) {
    const agent = this.agent;
    const call = this.call;
    if (!agent || !call) return;
    const code = pickLanguage(agent, { digits: digit });
    if (code && switchLanguage(this.db, agent, call, code, "keypad")) {
      this.interrupt();
      this.openEars();
      this.say(phrase(code, "retry").replace(/^[^.!?।]*[.!?।]\s*/, "") || "OK.", this.turn);
    }
  }

  async reply(text, mine) {
    const call = this.call;
    const agent = this.agent;
    if (!call || !agent || call.status === "ended") return this.finish();
    const live = () => mine === this.turn && !this.finished;

    // The owner pressed "Take over" in the live view.
    const owner = this.org?.ownerPhone || agent.transferNumber;
    if (call.takeover && owner) {
      this.say(phrase(this.language(), "connecting"), mine);
      return this.transfer(owner, "taken-over");
    }

    let pending = "";
    let spokeAny = false;
    const flushSentences = (final) => {
      let m;
      while ((m = SENTENCE_END.exec(pending))) {
        const cut = m.index + m[1].length;
        const sentence = speakable(pending.slice(0, cut));
        pending = pending.slice(cut).trimStart();
        if (sentence && live()) { this.say(sentence, mine); spokeAny = true; }
      }
      if (final && speakable(pending) && live()) { this.say(speakable(pending), mine); spokeAny = true; pending = ""; }
    };
    const before = call.language;
    const { reply, action, streamed } = await respond(this.db, agent, call, text, {
      onText: (delta) => {
        if (!live() || !delta) return;
        pending += delta;
        flushSentences(false);
      },
    });
    if (!live()) return;
    if (streamed) flushSentences(true);
    if (!streamed || !spokeAny) this.say(reply, mine);
    if (call.language !== before || this.language() !== this.earsLanguage) this.openEars();

    if (action?.type === "hangup") this.afterSpeaking(() => this.finish("completed"));
    else if (action?.type === "transfer") {
      const human = action.number || agent.transferNumber || this.org?.ownerPhone;
      if (human) this.transfer(human, "transferred");
    }
  }

  /** Speak text: synthesis starts now, playback stays in order. */
  say(text, mine) {
    const clean = speakable(text);
    if (!clean || this.finished) return;
    const language = this.language();
    if (this.engines.tts === "browser") {
      this.playChain = this.playChain.then(() => {
        if (mine !== this.turn || this.finished) return;
        this.send({ event: "say", text: clean, language });
        this.extendSpeaking(Math.min(15000, 400 + clean.length * 65));
      });
      return;
    }
    const audio = synthesize({ engine: this.engines.tts, org: this.org, text: clean, language }).catch((err) => {
      console.error(`Text-to-speech (${this.engines.tts}) failed:`, err.message);
      return null;
    });
    this.playChain = this.playChain.then(async () => {
      const pcm = await audio;
      if (!pcm || mine !== this.turn || this.finished) return;
      if (this.carrierId === "web") this.send({ event: "caption", role: "agent", text: clean });
      this.play(pcm);
    });
  }

  play(pcm) {
    for (const frame of chunks(pcm, FRAME * 5)) this.send(this.carrier.media(frame, this.stream, this.options));
    this.send(this.carrier.mark(this.stream, `m${++this.marks}`));
    this.extendSpeaking(durationMs(pcm));
  }

  extendSpeaking(ms) {
    this.speakingUntil = Math.max(Date.now(), this.speakingUntil) + ms;
  }

  /** Barge-in: drop unplayed audio and the reply still being generated. */
  interrupt() {
    this.turn++;
    this.speakingUntil = 0;
    this.playChain = Promise.resolve();
    this.send(this.carrier.clear(this.stream));
    const call = this.call;
    if (call) this.db.update("calls", call.id, { interruptions: (call.interruptions || 0) + 1 });
  }

  checkSilence() {
    if (this.finished || this.speaking()) return;
    const quietSince = Math.max(this.lastHeardAt, this.speakingUntil);
    if (Date.now() - quietSince < SILENCE_MS()) return;
    this.lastHeardAt = Date.now();
    this.silences++;
    const code = this.language();
    if (this.silences > MAX_SILENCES) {
      this.say(phrase(code, "noInput"), this.turn);
      this.afterSpeaking(() => this.finish("no-response"));
    } else {
      this.say(phrase(code, "retry"), this.turn);
    }
  }

  /** Run fn once everything queued has been heard. Cancelled if the caller talks first, unless `always`. */
  afterSpeaking(fn, always = false) {
    const mine = this.turn;
    this.playChain = this.playChain.then(() => new Promise((resolve) => {
      const wait = Math.max(0, this.speakingUntil - Date.now()) + 300;
      setTimeout(() => {
        resolve();
        if (!this.finished && (always || mine === this.turn)) fn();
      }, wait).unref?.();
    }));
  }

  transfer(number, outcome) {
    const call = this.call;
    if (!call) return;
    this.db.update("calls", call.id, { handoff: true, transferTo: number });
    this.afterSpeaking(async () => {
      const creds = credsFor(this.org, this.carrierId);
      const from = call.numberId ? this.db.get("numbers", call.numberId)?.number : undefined;
      if (this.carrierId === "web") this.send({ event: "transfer", number });
      else if (call.providerCallId) {
        const done = await this.carrier.transfer(creds, call.providerCallId, {
          number, from, url: publicUrl(`/voice/${this.carrierId}/dial/${call.id}/${call.streamToken}`),
        }).catch((err) => ({ ok: false, error: err.message }));
        if (!done.ok) console.error(`Transfer through ${this.carrierId} failed:`, done.error);
      }
      this.finish(outcome);
    }, true);
  }

  send(msg) {
    if (msg) this.sendRaw(msg);
  }

  /** End the call from our side (hang up), or record that it ended. */
  async finish(outcome) {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.timer);
    this.ears?.close();
    const call = this.call;
    if (call && outcome && !["transferred", "taken-over"].includes(outcome) && call.providerCallId && this.carrierId !== "web") {
      await this.carrier.hangup(credsFor(this.org, this.carrierId), call.providerCallId).catch(() => null);
    }
    if (this.carrierId === "web") this.send({ event: "end", outcome: outcome || "ended" });
    if (call && call.status !== "ended") endCall(this.db, call, outcome || "caller-hung-up");
    this.closeSocket?.();
  }

  /** The phone company closed the stream (caller hung up). */
  closed() {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.timer);
    this.ears?.close();
    const call = this.call;
    if (call && call.status !== "ended") endCall(this.db, call, call.handoff ? "transferred" : "caller-hung-up");
  }
}
