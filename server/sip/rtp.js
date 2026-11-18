// RTP (RFC 3550): the call's audio, sent as small UDP packets every 20 ms.
// Each packet carries 160 G.711 samples (μ-law "PCMU" or A-law "PCMA").
// Keypad presses arrive as RFC 4733 "telephone-event" packets.
//
// One RtpSession per call leg: it receives the caller's audio, decodes it to
// 16-bit PCM for the voice engine, and plays our audio back at an exact 20 ms
// pace (sending quiet frames when we have nothing to say, which keeps NAT
// paths open and stops operators from timing the call out).
import crypto from "node:crypto";
import dgram from "node:dgram";
import { FRAME, decodeAlaw, decodeMulaw, encodeAlaw, encodeMulaw } from "../voice/audio.js";

export const CODECS = { 0: "PCMU", 8: "PCMA" };
const DTMF = "0123456789*#ABCD";

let nextPort = 0;

/** Bind a UDP socket on an even port within [min, max]. */
export async function bindRtpSocket({ min = Number(process.env.RTP_PORT_MIN) || 10000, max = Number(process.env.RTP_PORT_MAX) || 20000, host = "0.0.0.0" } = {}) {
  const span = Math.floor((max - min) / 2);
  for (let attempt = 0; attempt < 50; attempt++) {
    nextPort = (nextPort + 1 + Math.floor(Math.random() * 8)) % span;
    const port = min + nextPort * 2;
    const socket = dgram.createSocket("udp4");
    const ok = await new Promise((resolve) => {
      socket.once("error", () => resolve(false));
      socket.bind(port, host, () => resolve(true));
    });
    if (ok) return socket;
    socket.close();
  }
  throw new Error("No free RTP port");
}

export class RtpSession {
  constructor(socket, { payloadType = 0, dtmfType = 101 } = {}) {
    this.socket = socket;
    this.port = socket.address().port;
    this.payloadType = payloadType;
    this.dtmfType = dtmfType;
    this.remote = null; // { address, port }
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.seq = crypto.randomBytes(2).readUInt16BE(0);
    this.timestamp = crypto.randomBytes(4).readUInt32BE(0);
    this.queue = []; // Int16Array frames of 160 samples
    this.onAudio = null; // (Int16Array) => void
    this.onDtmf = null; // (digit) => void
    this.lastEvent = null;
    this.received = 0;
    this.sent = 0;
    this.latched = false;
    this.closed = false;
    this.silence = new Int16Array(FRAME);
    socket.on("message", (pkt, rinfo) => this.receive(pkt, rinfo));
  }

  setRemote(address, port, payloadType) {
    this.remote = { address, port };
    if (payloadType != null) this.payloadType = payloadType;
  }

  start() {
    if (this.timer || this.closed) return;
    let next = performance.now();
    const tick = () => {
      if (this.closed) return;
      this.sendFrame(this.queue.length ? this.queue.shift() : this.silence);
      next += 20;
      this.timer = setTimeout(tick, Math.max(0, next - performance.now()));
    };
    this.timer = setTimeout(tick, 0);
  }

  receive(pkt, rinfo) {
    if (pkt.length < 12 || pkt[0] >> 6 !== 2) return;
    // Symmetric RTP: answer to wherever the caller's audio really comes from (NAT).
    if (!this.latched && this.remote && (rinfo.address !== this.remote.address || rinfo.port !== this.remote.port)) {
      this.remote = { address: rinfo.address, port: rinfo.port };
    }
    this.latched = true;
    if (!this.remote) this.remote = { address: rinfo.address, port: rinfo.port };
    const cc = pkt[0] & 0x0f;
    const hasExtension = pkt[0] & 0x10;
    const pt = pkt[1] & 0x7f;
    let offset = 12 + cc * 4;
    if (hasExtension && pkt.length >= offset + 4) offset += 4 + pkt.readUInt16BE(offset + 2) * 4;
    let payload = pkt.subarray(offset);
    if (pkt[0] & 0x20 && payload.length) payload = payload.subarray(0, payload.length - payload[payload.length - 1]); // padding
    this.received++;
    if (pt === this.dtmfType && payload.length >= 4) {
      const ts = pkt.readUInt32BE(4);
      const ended = payload[1] & 0x80;
      if (ended && this.lastEvent !== ts) {
        this.lastEvent = ts;
        const digit = DTMF[payload[0]];
        if (digit) this.onDtmf?.(digit);
      }
      return;
    }
    if (pt === 0) this.onAudio?.(decodeMulaw(payload));
    else if (pt === 8) this.onAudio?.(decodeAlaw(payload));
  }

  /** Queue audio to play (any length; split into 20 ms frames). */
  play(pcm) {
    for (let i = 0; i < pcm.length; i += FRAME) {
      const frame = new Int16Array(FRAME);
      frame.set(pcm.subarray(i, Math.min(i + FRAME, pcm.length)));
      this.queue.push(frame);
    }
    this.start();
  }

  /** Barge-in: drop audio not yet sent. */
  clear() {
    this.queue = [];
  }

  queuedMs() {
    return this.queue.length * 20;
  }

  sendFrame(frame) {
    if (!this.remote || this.closed) return;
    const payload = this.payloadType === 8 ? encodeAlaw(frame) : encodeMulaw(frame);
    const head = Buffer.alloc(12);
    head[0] = 0x80;
    head[1] = this.payloadType & 0x7f;
    head.writeUInt16BE(this.seq, 2);
    head.writeUInt32BE(this.timestamp >>> 0, 4);
    head.writeUInt32BE(this.ssrc, 8);
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + FRAME) >>> 0;
    this.sent++;
    this.socket.send(Buffer.concat([head, payload]), this.remote.port, this.remote.address);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    try { this.socket.close(); } catch {}
  }
}
