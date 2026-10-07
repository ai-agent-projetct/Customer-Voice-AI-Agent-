// How the receptionist's words become sound on a phone call.
//
// Standard voices: Twilio <Say> with Google voices for each Indian language,
// with SSML <prosody> for speaking speed. Free to set up, works everywhere.
//
// Premium voices (optional): natural-sounding speech from ElevenLabs. We
// generate the audio, keep it in a small cache, and Twilio plays it with
// <Play>. Enable with ELEVENLABS_API_KEY; choose the voice with
// ELEVENLABS_VOICE_ID and the languages it should handle with
// ELEVENLABS_LANGUAGES (check ElevenLabs' current language list: coverage
// of Indian languages varies by model). Anything that fails falls back to
// the standard voice, so a call never goes silent.
import crypto from "node:crypto";
import { RATES, lang, voiceFor } from "./languages.js";

const CACHE_LIMIT = 500;
const cache = new Map(); // id -> { audio: Buffer, type }

export function premiumConfigured() {
  return Boolean(process.env.ELEVENLABS_API_KEY && process.env.PUBLIC_URL);
}

export function premiumLanguages() {
  return (process.env.ELEVENLABS_LANGUAGES || "en-IN,en-US,hi-IN,ta-IN").split(",").map((s) => s.trim());
}

export function premiumAvailable(code) {
  return premiumConfigured() && premiumLanguages().includes(code);
}

export const provider = {
  /** Returns { audio: Buffer, type } or throws. */
  async synthesize({ text, voiceId }) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_22050_32`, {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2" }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}`);
    return { audio: Buffer.from(await res.arrayBuffer()), type: "audio/mpeg" };
  },
};

export function cachedAudio(id) {
  return cache.get(id) ?? null;
}

async function premiumUrl(text, code) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8Ik7nT";
  const id = crypto.createHash("sha256").update(`${voiceId}|${code}|${text}`).digest("hex").slice(0, 32);
  if (!cache.has(id)) {
    const result = await provider.synthesize({ text, voiceId, code });
    cache.set(id, result);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  return `${process.env.PUBLIC_URL.replace(/\/$/, "")}/audio/${id}.mp3`;
}

export function escapeXml(text) {
  return String(text).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
}

/** Standard TwiML <Say> in the right language and voice, at the agent's speed. */
export function sayXml(agent, code, text) {
  const rate = RATES[agent.speakingRate] ?? null;
  const body = rate ? `<prosody rate="${rate}">${escapeXml(text)}</prosody>` : escapeXml(text);
  return `<Say voice="${escapeXml(voiceFor(agent, code))}" language="${lang(code).code}">${body}</Say>`;
}

/** TwiML that speaks `text`: premium <Play> when enabled and working, else <Say>. */
export async function speakXml(agent, code, text) {
  if (agent.voiceEngine === "premium" && premiumAvailable(code)) {
    try {
      return `<Play>${escapeXml(await premiumUrl(text, code))}</Play>`;
    } catch (err) {
      console.error("Premium voice failed, using standard voice:", err.message);
    }
  }
  return sayXml(agent, code, text);
}
