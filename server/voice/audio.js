// Audio helpers for the voice engine. Inside VoiceDesk every call's audio is
// 16-bit signed PCM, mono, 8000 samples per second ("telephone quality"),
// held in an Int16Array. Phone companies send and receive it either as
// G.711 μ-law (Twilio, Plivo, Vobiz) or as raw 16-bit PCM (Exotel), always
// base64-encoded inside JSON WebSocket messages.

export const RATE = 8000;
export const FRAME = 160; // 20 ms at 8 kHz

// ---------- G.711 μ-law ----------
const BIAS = 0x84;
const CLIP = 32635;

export function linearToMulaw(sample) {
  let s = Math.max(-CLIP, Math.min(CLIP, sample));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function mulawToLinear(byte) {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -magnitude : magnitude;
}

/** μ-law bytes (Buffer) → Int16Array */
export function decodeMulaw(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = mulawToLinear(buf[i]);
  return out;
}

/** Int16Array → μ-law bytes (Buffer) */
export function encodeMulaw(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToMulaw(pcm[i]);
  return out;
}

// ---------- 16-bit little-endian PCM ----------
export function pcmFromBytes(buf) {
  const n = Math.floor(buf.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

export function pcmToBytes(pcm) {
  const out = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i], i * 2);
  return out;
}

/** Linear-interpolation resampling. Good enough for speech at telephone rates. */
export function resample(pcm, from, to) {
  if (from === to || !pcm.length) return pcm;
  const ratio = from / to;
  const n = Math.max(1, Math.round(pcm.length / ratio));
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = pcm[Math.min(j, pcm.length - 1)];
    const b = pcm[Math.min(j + 1, pcm.length - 1)];
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

// ---------- WAV ----------
/** Reads a PCM WAV file (16-bit, or 8-bit μ-law) into { pcm, rate }. */
export function parseWav(buf) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file");
  }
  let offset = 12;
  let format = 1, channels = 1, rate = RATE, bits = 16;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    let size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body; // streamed WAVs
      const data = buf.subarray(body, body + size);
      let pcm = format === 7 ? decodeMulaw(data) : bits === 16 ? pcmFromBytes(data) : null;
      if (!pcm) throw new Error(`Unsupported WAV format (${format}/${bits}-bit)`);
      if (channels > 1) pcm = pcm.filter((_, i) => i % channels === 0);
      return { pcm, rate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no audio data");
}

export function buildWav(pcm, rate = RATE) {
  const data = pcmToBytes(pcm);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8, "ascii");
  head.write("fmt ", 12, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// ---------- Misc ----------
export function durationMs(pcm, rate = RATE) {
  return (pcm.length / rate) * 1000;
}

/** Root-mean-square loudness, 0..32767. */
export function rms(pcm) {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

export function concat(parts) {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Splits audio into chunks of `samples` (the last one may be shorter). */
export function chunks(pcm, samples) {
  const out = [];
  for (let i = 0; i < pcm.length; i += samples) out.push(pcm.subarray(i, i + samples));
  return out;
}

/** A soft tone, used by the offline test voice so calls are audible without any account. */
export function tone(ms, freq = 440, rate = RATE) {
  const n = Math.round((ms / 1000) * rate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 80, (n - i) / 80);
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 6000 * fade);
  }
  return out;
}
