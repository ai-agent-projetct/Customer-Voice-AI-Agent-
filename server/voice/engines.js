// Speech engines: the "ears" (speech-to-text) and "mouth" (text-to-speech)
// of VoiceDesk's own voice pipeline. They are independent of the phone
// company: the same engines work on Twilio, Plivo, Vobiz, Exotel and the
// browser.
//
//   Ears:  Deepgram (streaming) · Sarvam (streaming, Indian languages)
//   Mouth: ElevenLabs · Sarvam Bulbul · Deepgram Aura · your own voice server
//
// "Your own voice server" is any HTTP endpoint you run (for example an
// open-source TTS model on your own GPU, or a voice you trained): VoiceDesk
// POSTs {text, language, voice, sample_rate} and plays back the WAV or raw
// 16-bit PCM it returns. That is how VoiceDesk gets a voice of its own.
//
// Keys come from the business's Settings (stored on the org, never sent back
// to the browser) or from environment variables. "auto" picks Sarvam for
// Indian languages when a Sarvam key exists, otherwise the best available.
import WebSocket from "ws";
import { RATE, buildWav, concat, decodeMulaw, parseWav, pcmFromBytes, pcmToBytes, resample, tone } from "./audio.js";

/** Network seams, replaced in tests with local fake servers. */
export const voiceNet = { fetch: (...a) => fetch(...a), WebSocket };

export const ENDPOINTS = {
  deepgramListen: "wss://api.deepgram.com/v1/listen",
  deepgramSpeak: "https://api.deepgram.com/v1/speak",
  sarvamListen: "wss://api.sarvam.ai/speech-to-text-realtime/ws",
  sarvamSpeak: "https://api.sarvam.ai/text-to-speech",
  elevenlabs: "https://api.elevenlabs.io",
};

export const STT_ENGINES = {
  deepgram: { label: "Deepgram", needs: "deepgram" },
  sarvam: { label: "Sarvam (Indian languages)", needs: "sarvam" },
};
export const TTS_ENGINES = {
  elevenlabs: { label: "ElevenLabs", needs: "elevenlabs" },
  sarvam: { label: "Sarvam Bulbul (Indian languages)", needs: "sarvam" },
  deepgram: { label: "Deepgram Aura (English)", needs: "deepgram" },
  custom: { label: "Your own voice server", needs: "custom" },
};
export const KEY_ENV = {
  deepgram: "DEEPGRAM_API_KEY",
  sarvam: "SARVAM_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  custom: "CUSTOM_TTS_KEY",
};

const INDIAN = new Set(["hi", "ta", "te", "kn", "ml", "bn", "mr", "gu", "pa", "or"]);
const base = (code) => String(code || "en-IN").split("-")[0];
export const isIndianLanguage = (code) => INDIAN.has(base(code));

export function voiceSettings(org) {
  return { stt: "auto", tts: "auto", voices: {}, customTtsUrl: "", ...(org?.voice || {}) };
}

export function keyFor(org, name) {
  return org?.voiceKeys?.[name] || process.env[KEY_ENV[name]] || "";
}

function hasEngine(org, name) {
  if (name === "custom") return Boolean(voiceSettings(org).customTtsUrl || process.env.CUSTOM_TTS_URL);
  return Boolean(keyFor(org, name));
}

/**
 * Which ears and mouth to use for a call in `language` on `carrier`.
 * Returns { stt, tts, missing[] }. Engine "browser" means the visitor's own
 * browser listens/speaks (only for browser test calls); "mock" is the
 * offline test engine (VOICE_ENGINE=mock).
 */
export function chooseEngines(org, language, carrier = "phone") {
  if (process.env.VOICE_ENGINE === "mock") return { stt: "mock", tts: "mock", missing: [] };
  const s = voiceSettings(org);
  const indian = isIndianLanguage(language);
  const pick = (choice, order) => {
    if (choice && choice !== "auto") return hasEngine(org, choice) ? choice : null;
    return order.find((e) => hasEngine(org, e)) ?? null;
  };
  const stt = pick(s.stt, indian ? ["sarvam", "deepgram"] : ["deepgram", "sarvam"]);
  const tts = pick(s.tts, indian ? ["custom", "sarvam", "elevenlabs"] : ["custom", "elevenlabs", "deepgram", "sarvam"]);
  const missing = [];
  if (!stt && carrier !== "web") missing.push(s.stt && s.stt !== "auto" ? `${STT_ENGINES[s.stt]?.label ?? s.stt} key` : "a speech-to-text key (Deepgram or Sarvam)");
  if (!tts && carrier !== "web") missing.push(s.tts && s.tts !== "auto" ? `${TTS_ENGINES[s.tts]?.label ?? s.tts} setup` : "a voice (ElevenLabs, Sarvam, Deepgram or your own voice server)");
  return { stt: stt ?? (carrier === "web" ? "browser" : null), tts: tts ?? (carrier === "web" ? "browser" : null), missing };
}

// ======================= Speech-to-text =======================
/**
 * openStt({ engine, org, language, onSpeechStart, onPartial, onFinal, onError })
 * → { write(pcm8k Int16Array), close() }
 */
export function openStt(opts) {
  const make = { deepgram: deepgramStt, sarvam: sarvamStt, mock: mockStt }[opts.engine];
  if (!make) return { write() {}, close() {}, engine: opts.engine };
  return make(opts);
}

function deepgramLanguage(code) {
  const b = base(code);
  if (b === "en") return code === "en-US" ? "en-US" : "en-IN";
  if (b === "hi") return "hi";
  return "multi"; // other languages: Deepgram's multilingual model (Sarvam is better for these)
}

function deepgramStt({ org, language, onSpeechStart, onPartial, onFinal, onError }) {
  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_STT_MODEL || "nova-3",
    language: deepgramLanguage(language),
    encoding: "linear16",
    sample_rate: String(RATE),
    channels: "1",
    interim_results: "true",
    endpointing: process.env.DEEPGRAM_ENDPOINTING_MS || "300",
    utterance_end_ms: "1000",
    vad_events: "true",
    smart_format: "true",
  });
  const ws = new voiceNet.WebSocket(`${ENDPOINTS.deepgramListen}?${params}`, { headers: { authorization: `Token ${keyFor(org, "deepgram")}` } });
  const pending = [];
  let heard = []; // final pieces of the current utterance
  const flush = () => {
    const text = heard.join(" ").trim();
    heard = [];
    if (text) onFinal(text);
  };
  ws.on("open", () => pending.splice(0).forEach((b) => ws.send(b)));
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "SpeechStarted") onSpeechStart?.();
    else if (m.type === "Results") {
      const text = m.channel?.alternatives?.[0]?.transcript?.trim() || "";
      if (text) onPartial?.(text);
      if (m.is_final && text) heard.push(text);
      if (m.speech_final) flush();
    } else if (m.type === "UtteranceEnd") flush();
  });
  ws.on("error", (err) => onError?.(err));
  const keepAlive = setInterval(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: "KeepAlive" })), 8000);
  keepAlive.unref?.();
  return {
    engine: "deepgram",
    write(pcm) {
      const bytes = pcmToBytes(pcm);
      if (ws.readyState === ws.OPEN) ws.send(bytes);
      else if (ws.readyState === ws.CONNECTING && pending.length < 500) pending.push(bytes);
    },
    close() {
      clearInterval(keepAlive);
      try {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
        ws.close();
      } catch {}
    },
  };
}

function sarvamStt({ org, language, onSpeechStart, onFinal, onError }) {
  const params = new URLSearchParams({
    "language-code": isIndianLanguage(language) || base(language) === "en" ? `${base(language)}-IN` : "unknown",
    model: process.env.SARVAM_STT_MODEL || "saaras:v3-realtime",
    mode: "transcribe",
    sample_rate: "16000",
    input_audio_codec: "pcm_s16le",
    vad_signals: "true",
  });
  const ws = new voiceNet.WebSocket(`${ENDPOINTS.sarvamListen}?${params}`, { headers: { "api-subscription-key": keyFor(org, "sarvam") } });
  let buffered = [];
  let size = 0;
  const pending = [];
  const sendAudio = (pcm8k) => {
    const pcm16k = resample(pcm8k, RATE, 16000);
    const msg = JSON.stringify({ audio: { data: pcmToBytes(pcm16k).toString("base64"), sample_rate: "16000", encoding: "audio/wav" } });
    if (ws.readyState === ws.OPEN) ws.send(msg);
    else if (ws.readyState === ws.CONNECTING && pending.length < 100) pending.push(msg);
  };
  ws.on("open", () => pending.splice(0).forEach((m) => ws.send(m)));
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "events" && m.data?.signal_type === "START_SPEECH") onSpeechStart?.();
    else if (m.type === "data" && m.data?.transcript?.trim()) onFinal(m.data.transcript.trim());
    else if (m.type === "error") onError?.(new Error(m.data?.message || "Sarvam error"));
  });
  ws.on("error", (err) => onError?.(err));
  return {
    engine: "sarvam",
    write(pcm) {
      buffered.push(pcm);
      size += pcm.length;
      if (size >= 1600) { // send 200 ms at a time
        sendAudio(concat(buffered));
        buffered = [];
        size = 0;
      }
    },
    close() {
      try { ws.close(); } catch {}
    },
  };
}

/** Offline ears for tests and demos: text is injected with mockStt.say(text). */
export const mockSttRegistry = { open: new Set() };
function mockStt({ onSpeechStart, onPartial, onFinal }) {
  const handle = {
    engine: "mock",
    frames: 0,
    write() { handle.frames++; },
    say(text) {
      onSpeechStart?.();
      onPartial?.(text);
      onFinal(text);
    },
    close() { mockSttRegistry.open.delete(handle); },
  };
  mockSttRegistry.open.add(handle);
  return handle;
}

// ======================= Text-to-speech =======================
/** synthesize({ engine, org, text, language }) → Int16Array at 8 kHz */
export async function synthesize({ engine, org, text, language, voice }) {
  const v = voice ?? voiceSettings(org).voices?.[language] ?? voiceSettings(org).voices?.[base(language)] ?? "";
  const fn = { elevenlabs: elevenlabsTts, sarvam: sarvamTts, deepgram: deepgramTts, custom: customTts, mock: mockTts }[engine];
  if (!fn) throw new Error(`No voice engine "${engine}"`);
  return fn({ org, text, language, voice: v });
}

async function ok(res, name) {
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${name} HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
  }
  return res;
}

async function elevenlabsTts({ org, text, voice }) {
  const id = voice || process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8Ik7nT";
  const res = await voiceNet.fetch(`${ENDPOINTS.elevenlabs}/v1/text-to-speech/${encodeURIComponent(id)}?output_format=ulaw_8000`, {
    method: "POST",
    headers: { "xi-api-key": keyFor(org, "elevenlabs"), "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5" }),
    signal: AbortSignal.timeout(8000),
  });
  await ok(res, "ElevenLabs");
  return decodeMulaw(Buffer.from(await res.arrayBuffer()));
}

async function sarvamTts({ org, text, language, voice }) {
  const body = { text, target_language_code: `${base(language)}-IN`, speech_sample_rate: RATE };
  if (voice) body.speaker = voice;
  if (process.env.SARVAM_TTS_MODEL) body.model = process.env.SARVAM_TTS_MODEL;
  const res = await voiceNet.fetch(ENDPOINTS.sarvamSpeak, {
    method: "POST",
    headers: { "api-subscription-key": keyFor(org, "sarvam"), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  await ok(res, "Sarvam");
  const data = await res.json();
  const parts = (data.audios || []).map((b64) => {
    const { pcm, rate } = parseWav(Buffer.from(b64, "base64"));
    return resample(pcm, rate, RATE);
  });
  if (!parts.length) throw new Error("Sarvam returned no audio");
  return concat(parts);
}

async function deepgramTts({ org, text, voice }) {
  const params = new URLSearchParams({ model: voice || "aura-2-thalia-en", encoding: "linear16", sample_rate: String(RATE), container: "none" });
  const res = await voiceNet.fetch(`${ENDPOINTS.deepgramSpeak}?${params}`, {
    method: "POST",
    headers: { authorization: `Token ${keyFor(org, "deepgram")}`, "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(8000),
  });
  await ok(res, "Deepgram");
  return pcmFromBytes(Buffer.from(await res.arrayBuffer()));
}

/** Your own voice server. Accepts WAV, raw 16-bit PCM (8 kHz unless X-Sample-Rate says otherwise) or JSON {audio: base64 WAV}. */
async function customTts({ org, text, language, voice }) {
  const url = voiceSettings(org).customTtsUrl || process.env.CUSTOM_TTS_URL;
  if (!url) throw new Error("No voice server URL");
  const key = keyFor(org, "custom");
  const res = await voiceNet.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) },
    body: JSON.stringify({ text, language, voice, sample_rate: RATE, format: "wav" }),
    signal: AbortSignal.timeout(10000),
  });
  await ok(res, "Voice server");
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) {
    const { pcm, rate } = parseWav(Buffer.from((await res.json()).audio || "", "base64"));
    return resample(pcm, rate, RATE);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.toString("ascii", 0, 4) === "RIFF") {
    const { pcm, rate } = parseWav(buf);
    return resample(pcm, rate, RATE);
  }
  return resample(pcmFromBytes(buf), Number(res.headers.get("x-sample-rate")) || RATE, RATE);
}

/** Offline mouth: a short soft tone per sentence, and a record of what was said. */
export const mockTtsLog = [];
async function mockTts({ text, language }) {
  mockTtsLog.push({ text, language });
  if (mockTtsLog.length > 200) mockTtsLog.shift();
  return tone(Math.min(1200, 80 + text.length * 8));
}

/** A short spoken sample as a WAV file, for the "Preview voice" button. */
export async function previewWav({ engine, org, text, language, voice }) {
  return buildWav(await synthesize({ engine, org, text, language, voice }));
}
