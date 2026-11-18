// Call records for VoiceDesk Network: recordings (WAV files), per-minute
// billing, and the developer's status callback when a call ends.
import fs from "node:fs";
import path from "node:path";
import { buildWav, RATE } from "../voice/audio.js";
import { webhookUrlProblem } from "../webhooks.js";

export const recordingsDir = () => process.env.RECORDINGS_DIR || path.join(process.cwd(), "data", "recordings");

export function saveRecording(db, { orgId, callId, pcm, kind = "call" }) {
  const row = db.insert("recordings", { orgId, callId, kind, durationSec: Math.round(pcm.length / RATE) });
  fs.mkdirSync(recordingsDir(), { recursive: true });
  fs.writeFileSync(path.join(recordingsDir(), `${row.id}.wav`), buildWav(pcm));
  return row;
}

export function recordingFile(row) {
  const file = path.join(recordingsDir(), `${row.id}.wav`);
  return fs.existsSync(file) ? file : null;
}

/** Per-minute prices in paise (₹1 = 100 paise); set your own in the environment. */
export function rates() {
  return {
    inbound: Number(process.env.VOICE_RATE_INBOUND_PAISE ?? 40),
    outbound: Number(process.env.VOICE_RATE_OUTBOUND_PAISE ?? 60),
  };
}

/** Billable minutes (rounded up, answered time only) and cost, stored on the call. */
export function billCall(db, call) {
  const answered = call.answeredAt ? new Date(call.answeredAt).getTime() : null;
  const ended = call.endedAt ? new Date(call.endedAt).getTime() : Date.now();
  const seconds = answered ? Math.max(0, Math.round((ended - answered) / 1000)) : 0;
  const minutes = seconds ? Math.ceil(seconds / 60) : 0;
  const rate = call.direction === "outbound" ? rates().outbound : rates().inbound;
  return db.update("calls", call.id, { talkSeconds: seconds, billedMinutes: minutes, costPaise: minutes * rate });
}

export function publicVoiceCall(db, c) {
  const recording = c.recordingId ? db.get("recordings", c.recordingId) : null;
  return {
    id: c.id,
    status: c.status === "ended" ? "completed" : c.answeredAt ? "in-progress" : "ringing",
    outcome: c.outcome ?? null,
    direction: c.direction || "inbound",
    from: c.direction === "outbound" ? c.fromNumber : c.callerNumber,
    to: c.direction === "outbound" ? c.callerNumber : c.fromNumber,
    created_at: c.createdAt,
    answered_at: c.answeredAt ?? null,
    ended_at: c.endedAt ?? null,
    talk_seconds: c.talkSeconds ?? null,
    billed_minutes: c.billedMinutes ?? null,
    cost_inr: c.costPaise == null ? null : c.costPaise / 100,
    recording: recording ? { id: recording.id, seconds: recording.durationSec, url: `/api/v1/voice/recordings/${recording.id}` } : null,
    handled_by: c.channel === "api" ? "flow" : "ai",
    error: c.error ?? null,
    events: (c.flowLog || []).slice(-50),
  };
}

/** POST JSON to a developer's URL (same safety rules as webhooks). */
export async function postJson(url, body, { timeoutMs = 8000 } = {}) {
  const problem = urlProblem(url);
  if (problem) throw new Error(problem);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "VoiceDesk-Voice/1" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function fetchBytes(url, { maxBytes = 10 * 1024 * 1024 } = {}) {
  const problem = urlProblem(url);
  if (problem) throw new Error(problem);
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: "error" });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error("Audio file is too large (10 MB max).");
  return buf;
}

export function urlProblem(url) {
  // Local development servers are allowed only when explicitly enabled (never in production).
  if (process.env.VOICE_ALLOW_LOCAL_URLS === "1" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) return null;
  return webhookUrlProblem(url);
}

/** Tell the developer the call ended (fire and forget). */
export function notifyStatus(db, call) {
  if (!call.statusCallback) return;
  postJson(call.statusCallback, { event: "call.completed", call: publicVoiceCall(db, call) }).catch((err) =>
    console.error("Voice status callback failed:", err.message));
}
