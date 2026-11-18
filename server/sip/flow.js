// VoiceDesk call flows: the programmable part of VoiceDesk Network (what
// TwiML is to Twilio and Plivo XML is to Plivo). A flow is a JSON list of
// steps run on a live call:
//
//   [
//     { "say": "Welcome to Glow Salon", "language": "en-IN" },
//     { "gather": { "numDigits": 1, "timeout": 5,
//                   "prompt": [{ "say": "Press 1 for bookings, 2 to talk to us" }],
//                   "options": { "1": [{ "ai": {} }], "2": [{ "dial": { "number": "+919845000001" } }] },
//                   "action": "https://your.app/ivr" } },
//     { "record": { "maxSeconds": 60, "finishOnKey": "#" } },
//     { "hangup": true }
//   ]
//
// Steps: say · play (WAV URL) · pause · gather (keypad or speech) · dial ·
// record · ai (hand the call to an AI receptionist) · redirect · hangup.
// "action" and "redirect" URLs receive a POST and answer with the next flow.
import { chooseEngines, openStt, synthesize } from "../voice/engines.js";
import { RATE, parseWav, resample } from "../voice/audio.js";

const MAX_STEPS = 200;
const MAX_FETCHES = 25;

export class FlowError extends Error {}

/** Checks a flow's shape before it runs (API input). Returns an error string or null. */
export function flowProblem(flow, depth = 0) {
  if (!Array.isArray(flow)) return "A flow must be a list of steps.";
  if (depth > 4) return "Flows can nest at most 4 levels.";
  for (const step of flow) {
    if (!step || typeof step !== "object") return "Each step must be an object.";
    const verbs = ["say", "play", "pause", "gather", "dial", "record", "ai", "redirect", "hangup"].filter((v) => v in step);
    if (verbs.length !== 1) return `Each step needs exactly one of: say, play, pause, gather, dial, record, ai, redirect, hangup.`;
    const v = verbs[0];
    if (v === "say" && !String(step.say || "").trim()) return "say needs text.";
    if (v === "dial" && !/^\+?\d{8,15}$/.test(String(step.dial?.number ?? step.dial ?? "").replace(/[\s-]/g, ""))) return "dial needs a phone number.";
    if (v === "gather") {
      const g = step.gather || {};
      if (g.prompt) { const p = flowProblem(g.prompt, depth + 1); if (p) return p; }
      for (const branch of Object.values(g.options || {})) { const p = flowProblem(branch, depth + 1); if (p) return p; }
    }
  }
  return null;
}

/**
 * Run a flow on a call leg.
 * ctx: { db, org, callId, leg, language, fetchFlow(url, payload) → steps, bridge(number, from) → Promise,
 *        startAi(agentId), recordingDone(pcm, meta), log(event) }
 */
export async function runFlow(ctx, flow) {
  ctx.steps ??= 0;
  ctx.fetches ??= 0;
  const queue = [...flow];
  while (queue.length) {
    if (ended(ctx)) return "ended";
    if (++ctx.steps > MAX_STEPS) throw new FlowError("Flow ran too many steps.");
    const step = queue.shift();
    const verb = Object.keys(step).find((k) => k !== "language" && k !== "voice");
    ctx.log?.({ step: verb });
    switch (verb) {
      case "say": await say(ctx, String(step.say), step.language || ctx.language, step.voice); break;
      case "play": await play(ctx, String(step.play?.url ?? step.play)); break;
      case "pause": await sleep(Math.min(30, Number(step.pause?.seconds ?? step.pause) || 1) * 1000); break;
      case "gather": {
        const result = await gather(ctx, step.gather || {});
        const g = step.gather || {};
        if (result.value && g.options?.[result.value]) {
          queue.unshift(...g.options[result.value]);
        } else if (g.action) {
          const next = await fetchNext(ctx, g.action, { ...result });
          if (next) { queue.length = 0; queue.push(...next); }
        } else if (!result.value && g.noInput) {
          queue.unshift(...g.noInput);
        }
        break;
      }
      case "dial": {
        const d = typeof step.dial === "object" ? step.dial : { number: step.dial };
        const outcome = await ctx.bridge(String(d.number), d.callerId);
        ctx.log?.({ step: "dial", outcome });
        if (d.action) {
          const next = await fetchNext(ctx, d.action, { dial_status: outcome });
          if (next) { queue.length = 0; queue.push(...next); }
        }
        break;
      }
      case "record": {
        const r = step.record || {};
        const meta = await record(ctx, r);
        if (r.action) {
          const next = await fetchNext(ctx, r.action, meta);
          if (next) { queue.length = 0; queue.push(...next); }
        }
        break;
      }
      case "ai":
        ctx.startAi(step.ai?.agentId);
        return "ai";
      case "redirect": {
        const next = await fetchNext(ctx, String(step.redirect?.url ?? step.redirect), {});
        queue.length = 0;
        if (next) queue.push(...next);
        break;
      }
      case "hangup":
        await ctx.leg.rtp?.drained();
        await ctx.leg.bye();
        return "hangup";
      default:
        throw new FlowError(`Unknown step: ${verb}`);
    }
  }
  return "done";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
const ended = (ctx) => ctx.leg.state === "ended";

async function fetchNext(ctx, url, payload) {
  if (++ctx.fetches > MAX_FETCHES) throw new FlowError("Flow fetched too many URLs.");
  const steps = await ctx.fetchFlow(url, payload);
  const problem = steps && flowProblem(steps);
  if (problem) throw new FlowError(`The flow from ${url} is invalid: ${problem}`);
  return steps;
}

async function say(ctx, text, language, voice) {
  const engine = chooseEngines(ctx.org, language).tts;
  if (!engine) throw new FlowError("No voice is set up for this language (Settings → Phone & voice).");
  const pcm = await synthesize({ engine, org: ctx.org, text, language, voice });
  if (ended(ctx)) return;
  ctx.leg.rtp.play(pcm);
  await ctx.leg.rtp.drained();
}

async function play(ctx, url) {
  const wav = await ctx.fetchAudio(url);
  const { pcm, rate } = parseWav(wav);
  if (ended(ctx)) return;
  ctx.leg.rtp.play(resample(pcm, rate, RATE));
  await ctx.leg.rtp.drained();
}

/** Keypad or speech input. Resolves { value, input } ("" if nothing). */
async function gather(ctx, g) {
  const input = g.input === "speech" ? "speech" : g.input === "both" ? "both" : "dtmf";
  const numDigits = Math.max(1, Math.min(20, Number(g.numDigits) || (g.options ? 1 : 20)));
  const finishOnKey = g.finishOnKey ?? "#";
  const timeoutMs = Math.min(60, Number(g.timeout) || 5) * 1000;
  const rtp = ctx.leg.rtp;
  let digits = "";
  let speech = "";
  let done;
  const finished = new Promise((resolve) => (done = resolve));
  const prevDtmf = rtp.onDtmf;
  const prevAudio = rtp.onAudio;
  if (input !== "speech") {
    rtp.onDtmf = (d) => {
      rtp.clear(); // stop the prompt as soon as a key is pressed
      if (d === finishOnKey) return done();
      digits += d;
      if (digits.length >= numDigits) done();
    };
  }
  let ears = null;
  if (input !== "dtmf") {
    const engine = chooseEngines(ctx.org, g.language || ctx.language).stt;
    if (engine) {
      ears = openStt({ engine, org: ctx.org, language: g.language || ctx.language, onFinal: (t) => { speech = t; rtp.clear(); done(); } });
      ctx.ears = ears;
      rtp.onAudio = (pcm) => ears.write(pcm);
    }
  }
  const endWatch = setInterval(() => ended(ctx) && done(), 100);
  try {
    for (const step of g.prompt || []) {
      if (digits || speech || ended(ctx)) break;
      await runFlow({ ...ctx, steps: ctx.steps }, [step]);
    }
    if (!digits && !speech) {
      const timer = setTimeout(done, timeoutMs);
      await finished;
      clearTimeout(timer);
    } else if (digits.length < numDigits && !speech && input !== "speech" && !digits.endsWith(finishOnKey)) {
      // Keys pressed during the prompt: allow the rest within the timeout.
      const timer = setTimeout(done, timeoutMs);
      await finished;
      clearTimeout(timer);
    }
  } finally {
    clearInterval(endWatch);
    rtp.onDtmf = prevDtmf;
    rtp.onAudio = prevAudio;
    ears?.close();
  }
  return speech ? { value: speech, input: "speech", speech } : { value: digits, input: "dtmf", digits };
}

/** Record the caller (voicemail-style) until maxSeconds, the finish key or hang-up. */
async function record(ctx, r) {
  const rtp = ctx.leg.rtp;
  const maxMs = Math.min(600, Number(r.maxSeconds) || 60) * 1000;
  const finishOnKey = r.finishOnKey ?? "#";
  const frames = [];
  const prevAudio = rtp.onAudio;
  const prevDtmf = rtp.onDtmf;
  let done;
  const finished = new Promise((resolve) => (done = resolve));
  rtp.onAudio = (pcm) => { frames.push(pcm); prevAudio?.(pcm); };
  rtp.onDtmf = (d) => d === finishOnKey && done("key");
  const timer = setTimeout(() => done("max-length"), maxMs);
  const endWatch = setInterval(() => ended(ctx) && done("hangup"), 100);
  const reason = await finished;
  clearTimeout(timer);
  clearInterval(endWatch);
  rtp.onAudio = prevAudio;
  rtp.onDtmf = prevDtmf;
  const pcm = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) { pcm.set(f, at); at += f.length; }
  const saved = await ctx.recordingDone(pcm, { kind: "message" });
  return { recording_id: saved.id, recording_seconds: Math.round(pcm.length / RATE), finished_by: reason };
}
