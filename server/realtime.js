// Real-time voice: sub-second replies and barge-in, using Twilio
// ConversationRelay. Twilio keeps one WebSocket open per call and does the
// streaming speech recognition and text-to-speech; we receive what the caller
// said as text and send the reply back piece by piece while Claude is still
// writing it. If the caller starts talking, Twilio stops the voice and tells us.
//
//   Twilio → us:  setup · prompt {voicePrompt} · interrupt · dtmf · error
//   us → Twilio:  text {token,last} · language {ttsLanguage,transcriptionLanguage} · end {handoffData}
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { respond } from "./agent.js";
import { endCall } from "./calls.js";
import { agentLanguages, lang, phrase, voiceFor } from "./languages.js";
import { escapeXml } from "./tts.js";
import { handleStreamUpgrade } from "./voice/router.js";

export function realtimeAvailable() {
  return Boolean(process.env.PUBLIC_URL);
}

/** A per-call secret, so only Twilio (which got it in the TwiML) can open the call's socket. */
export function relayToken(db, call) {
  if (!call.relayToken) {
    call.relayToken = crypto.randomBytes(18).toString("base64url");
    db.update("calls", call.id, { relayToken: call.relayToken });
  }
  return call.relayToken;
}

/** TwiML that hands the call to the real-time socket, greeting first. */
export function relayXml(db, agent, call, greeting) {
  const code = call.language ?? agent.language;
  const base = process.env.PUBLIC_URL.replace(/\/$/, "").replace(/^http/, "ws");
  const url = `${base}/realtime/${call.id}/${relayToken(db, call)}`;
  // Every language the receptionist speaks must be declared up front so it can switch mid-call.
  const languages = agentLanguages(agent)
    .map((c) => `<Language code="${lang(c).code}" ttsProvider="Google" voice="${escapeXml(voiceFor(agent, c).replace(/^Google\./, ""))}" transcriptionProvider="Google"/>`)
    .join("");
  return (
    `<Connect action="/twilio/relay-done/${call.id}">` +
    `<ConversationRelay url="${escapeXml(url)}" welcomeGreeting="${escapeXml(greeting)}" welcomeGreetingInterruptible="speech" ` +
    `language="${lang(code).code}" interruptible="speech" dtmfDetection="true">${languages}</ConversationRelay></Connect>`
  );
}

export function attachRealtime(server, db) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    // VoiceDesk's own voice pipeline (Twilio, Plivo, Vobiz, Exotel, browser).
    if (handleStreamUpgrade(db, req, socket, head)) return;
    const match = /^\/realtime\/([\w-]+)\/([\w-]+)$/.exec(new URL(req.url, "http://x").pathname);
    const call = match && db.get("calls", match[1]);
    const ok = call && call.relayToken && call.status !== "ended" && safeEqual(call.relayToken, match[2]);
    if (!ok) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleCall(db, ws, call.id));
  });
  return wss;
}

function handleCall(db, ws, callId) {
  const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  let spokenLanguage = null; // language Twilio is currently speaking/listening in
  let turn = 0; // increases on every prompt and interrupt; stale replies are dropped
  let queue = Promise.resolve();

  const syncLanguage = (call, agent) => {
    const code = call.language ?? agent.language;
    if (spokenLanguage && code !== spokenLanguage) send({ type: "language", ttsLanguage: lang(code).code, transcriptionLanguage: lang(code).code });
    spokenLanguage = code;
  };

  async function onPrompt(text) {
    const mine = ++turn;
    const call = db.get("calls", callId);
    const agent = call && db.get("agents", call.agentId);
    if (!call || !agent || call.status === "ended") return send({ type: "end" });
    const live = () => mine === turn;

    // The owner pressed "Take over" in the live view.
    const owner = db.get("orgs", agent.orgId)?.ownerPhone || agent.transferNumber;
    if (call.takeover && owner) {
      send({ type: "text", token: phrase(call.language ?? agent.language, "connecting"), last: true });
      return send({ type: "end", handoffData: JSON.stringify({ transfer: owner, outcome: "taken-over" }) });
    }

    let streamedAny = false;
    const { reply, action, streamed } = await respond(db, agent, call, text, {
      onText: (delta) => {
        if (!live() || !delta) return;
        syncLanguage(call, agent);
        streamedAny = true;
        send({ type: "text", token: delta, last: false });
      },
    });
    if (!live()) return; // the caller interrupted; they are already saying something new
    syncLanguage(call, agent);
    send({ type: "text", token: streamed && streamedAny ? "" : reply, last: true });

    if (action?.type === "hangup") {
      send({ type: "end", handoffData: JSON.stringify({ outcome: "completed" }) });
    } else if (action?.type === "transfer") {
      const human = action.number || agent.transferNumber || db.get("orgs", agent.orgId)?.ownerPhone;
      if (human) send({ type: "end", handoffData: JSON.stringify({ transfer: human, outcome: "transferred" }) });
    }
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "setup" || msg.type === "connected") {
      const call = db.get("calls", callId);
      if (call) {
        spokenLanguage = call.language;
        db.update("calls", callId, { realtime: true, twilioSid: msg.callSid || call.twilioSid });
      }
    } else if (msg.type === "prompt" && String(msg.voicePrompt || "").trim() && msg.last !== false) {
      const text = String(msg.voicePrompt).trim().slice(0, 2000);
      queue = queue.then(() => onPrompt(text)).catch((err) => console.error("realtime turn failed", err));
    } else if (msg.type === "interrupt") {
      turn++; // drop whatever is still being generated for the interrupted reply
      const call = db.get("calls", callId);
      if (call) db.update("calls", callId, { interruptions: (call.interruptions || 0) + 1 });
    } else if (msg.type === "error") {
      console.error("ConversationRelay error:", msg.description);
    }
  });

  ws.on("close", () => {
    const call = db.get("calls", callId);
    // If the caller simply hung up, no handoff happened: close the call here.
    if (call && call.status !== "ended" && !call.handoff) setTimeout(() => {
      const again = db.get("calls", callId);
      if (again && again.status !== "ended") endCall(db, again, "caller-hung-up");
    }, 1500).unref();
  });
}

function safeEqual(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
