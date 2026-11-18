// Phone & voice: VoiceDesk's own voice on any phone company.
//   1. Voice engine: the AI's ears (speech-to-text) and mouth (text-to-speech)
//   2. Phone companies: Twilio, Plivo, Vobiz, Exotel logins
//   3. Phone numbers: which receptionist answers which number, URLs to paste
//   4. Try it: talk to your AI in the browser, or have it ring your phone
import { api, h, onLeave, pill, route, shell, state, toast } from "../core.js";

const ENGINE_KEYS = [
  ["deepgram", "Deepgram API key", "Ears for English and Hindi, plus Aura voices (English)."],
  ["sarvam", "Sarvam API key", "Ears and voices for Indian languages (Tamil, Telugu, Kannada, Malayalam, Bengali, Marathi, Gujarati, Punjabi, Hindi)."],
  ["elevenlabs", "ElevenLabs API key", "Natural multilingual voices, including cloned voices."],
];

route("voice", async () => {
  const v = await api("GET", "/phone-voice");
  const e = v.engines;
  const langs = [...new Set(v.agents.flatMap((a) => a.languages))];
  const opt = (value, label, current) => `<option value="${h(value)}" ${value === current ? "selected" : ""}>${h(label)}</option>`;
  const keyInput = (name, label, help) => `
    <label>${h(label)} ${e.keys[name].set ? pill(e.keys[name].fromEnv ? "Set on server" : `Saved ${e.keys[name].last4}`, "") : pill("Not set", "grey")}
      <input name="key-${name}" type="password" autocomplete="off" placeholder="${e.keys[name].set ? "Paste a new key to replace" : "Paste key"}">
      <span class="muted small" style="font-weight:400">${h(help)}</span></label>`;

  const ready = v.readiness.flatMap((r) => r.languages.map((l) => ({ ...l, agentName: r.agentName })));
  const allReady = ready.length && ready.every((l) => l.stt && l.tts);

  shell("voice", `
    <div class="page-head"><div><h1>Phone & voice</h1>
      <p class="muted">Your receptionist's own voice, on any phone company. VoiceDesk listens, thinks and speaks itself, and the phone company only carries the call, so you can switch companies anytime.</p></div></div>

    <div class="banner ${allReady ? "ok" : ""}">
      ${allReady ? "✅ Voice is ready for every language your receptionists speak." : !ready.length ? "⚠️ Add a receptionist first." : (() => {
        const groups = {};
        for (const l of ready.filter((x) => !x.stt || !x.tts)) (groups[l.missing.join(" and ")] ??= new Set()).add(l.name);
        return Object.entries(groups).map(([need, names]) => `⚠️ To answer calls in ${h([...names].join(", "))}, add ${h(need)} below.`).join("<br>");
      })()}
      ${v.publicUrl ? "" : `<br>⚠️ The server's public address (PUBLIC_URL) isn't set, so phone companies can't reach VoiceDesk yet.`}
    </div>

    <form class="panel" id="engines">
      <h2>1. Voice engine</h2>
      <p class="muted small">The <b>ears</b> turn the caller's speech into text and the <b>mouth</b> speaks the reply. "Automatic" picks Sarvam for Indian languages and Deepgram/ElevenLabs for English, using whichever keys you've added.</p>
      <div class="form-grid">
        <label>Ears (speech-to-text)<select name="stt">${opt("auto", "Automatic", e.stt)}${Object.entries(e.sttOptions).map(([k, o]) => opt(k, o.label, e.stt)).join("")}</select></label>
        <label>Mouth (voice)<select name="tts">${opt("auto", "Automatic", e.tts)}${Object.entries(e.ttsOptions).map(([k, o]) => opt(k, o.label, e.tts)).join("")}</select></label>
      </div>
      ${ENGINE_KEYS.map(([n, l, help]) => keyInput(n, l, help)).join("")}
      <details ${e.customTtsUrl ? "open" : ""}><summary><b>Your own voice server</b> (a voice that belongs to your company)</summary>
        <p class="muted small">Run any text-to-speech model yourself (for example an open-source Indian-language model on your own GPU, or a voice you trained). VoiceDesk sends <code>POST {"text","language","voice","sample_rate":8000}</code> and plays the WAV or 16-bit PCM it returns.</p>
        <label>Voice server URL<input name="customTtsUrl" value="${h(e.customTtsUrl)}" placeholder="https://voice.yourcompany.in/tts"></label>
        ${keyInput("custom", "Voice server key (optional)", "Sent as Authorization: Bearer <key>.")}
      </details>
      ${langs.length ? `<p class="label">Voice for each language <span class="muted small" style="font-weight:400">(ElevenLabs voice ID, Sarvam speaker name, Deepgram Aura model, or your server's voice name; leave empty for the default)</span></p>
      <div class="form-grid">${langs.map((c) => `<label>${h(c)}<input name="voice-${h(c)}" value="${h(e.voices[c] || "")}" placeholder="default"></label>`).join("")}</div>` : ""}
      <div class="save-bar"><button class="btn btn-primary">Save voice engine</button></div>
    </form>

    <div class="panel">
      <h2>Hear the voice</h2>
      <div class="form-grid">
        <label>Language<select id="pv-lang">${(langs.length ? langs : ["en-IN"]).map((c) => opt(c, c, langs[0])).join("")}</select></label>
        <label>Text (empty = your greeting)<input id="pv-text" placeholder="Hello! Thanks for calling…"></label>
      </div>
      <button class="btn" id="pv-play">▶ Play sample</button> <span class="muted small" id="pv-info"></span>
    </div>

    <div class="panel">
      <h2>2. Phone network</h2>
      <div class="carrier-card network-card">
        <div class="row-between"><strong>📡 VoiceDesk Network (our own)</strong>${v.network.enabled ? pill(v.network.canDial ? "Live" : "Incoming only", "") : pill("Not switched on", "grey")}</div>
        <p class="small" style="margin:8px 0 0">VoiceDesk's own telephony: calls come straight from an Indian operator's SIP line into VoiceDesk, with no Twilio, Plivo, Vobiz or Exotel in between. Numbers on this network are given by the VoiceDesk team; nothing to set up here.${v.network.enabled && v.network.registered ? " Logged in to the operator ✅" : ""}</p>
      </div>
      <p class="muted small" style="margin-top:14px">Or bring your own account with another phone company:</p>
      <p class="muted small">Connect one or more. Each number uses its own company; outbound calls use your receptionist's number.</p>
      <div class="carrier-grid">${v.carriers.map((c) => `
        <form class="carrier-card" data-carrier="${h(c.id)}">
          <div class="row-between"><strong>${h(c.label)}</strong>${c.ready ? pill("Connected", "") : pill("Not connected", "grey")}</div>
          ${c.fields.map((f) => `<label>${h(f.label)}${f.fromEnv ? ` ${pill("on server", "grey")}` : ""}
            <input name="${h(f.name)}" ${f.secret ? `type="password" autocomplete="off" placeholder="${f.set ? `Saved ${h(f.last4 || "")}` : ""}"` : `value="${h(f.value)}"`}></label>`).join("")}
          ${c.id === "exotel" ? `<label>Audio format<select name="encoding">${opt("slin", "16-bit PCM (Exotel default)", c.encoding)}${opt("mulaw", "μ-law", c.encoding)}</select></label>` : ""}
          <p class="muted small">${h(c.setup)}</p>
          <button class="btn btn-primary small">Save ${h(c.label)}</button>
        </form>`).join("")}</div>
    </div>

    <div class="panel">
      <h2>3. Phone numbers</h2>
      ${v.numbers.length ? `<div class="table-wrap"><table><thead><tr><th>Number</th><th>Company</th><th>Answered by</th><th>Calls out</th><th>Paste this in your phone company</th><th></th></tr></thead><tbody>
        ${v.numbers.map((n) => `<tr data-id="${h(n.id)}">
          <td><b>${h(n.number)}</b>${n.label ? `<br><span class="muted small">${h(n.label)}</span>` : ""}</td>
          <td>${n.carrier === "voicedesk" ? "VoiceDesk Network" : h(v.carriers.find((c) => c.id === n.carrier)?.label || n.carrier)}</td>
          <td><select data-agent>${opt("", "Nobody", n.agentId || "")}${v.agents.map((a) => opt(a.id, a.name, n.agentId || "")).join("")}</select></td>
          <td><input type="checkbox" data-out ${n.outbound ? "checked" : ""}></td>
          <td class="url-cell">${n.carrier === "voicedesk" ? `<span class="muted small">Connected directly: nothing to paste</span>` : `<span class="muted small">${n.streamUrl ? "Voicebot stream URL" : "Answer URL (POST)"}</span><code>${h(n.streamUrl || n.answerUrl)}</code><button type="button" class="btn small" data-copy="${h(n.streamUrl || n.answerUrl)}">Copy</button>`}</td>
          <td>${n.carrier === "voicedesk" ? "" : `<button type="button" class="btn small" data-del>Remove</button>`}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">No numbers yet. Buy a number from your phone company, then add it here.</p>`}
      <form id="add-number" class="form-grid" style="margin-top:14px">
        <label>Phone number<input name="number" placeholder="+91 80 4567 8901" required></label>
        <label>Company<select name="carrier">${v.carriers.map((c) => opt(c.id, c.label, "")).join("")}</select></label>
        <label>Answered by<select name="agentId">${v.agents.map((a) => opt(a.id, a.name, "")).join("")}</select></label>
        <label>Label<input name="label" placeholder="Main line"></label>
        <div><button class="btn btn-primary">Add number</button></div>
      </form>
    </div>

    <div class="panel">
      <h2>4. Try it</h2>
      <div class="form-grid">
        <label>Receptionist<select id="try-agent">${v.agents.map((a) => opt(a.id, a.name, "")).join("")}</select></label>
        <div class="actions" style="align-self:end"><button class="btn btn-primary" id="web-call">🎙 Talk in the browser</button><button class="btn" id="ring-me">📞 Ring my phone</button></div>
      </div>
      <p class="muted small">Browser calls go through the same voice pipeline as phone calls. Use headphones so the AI doesn't hear itself. Without voice keys, your browser's own speech is used (best in Chrome).</p>
      <div id="call-box" hidden>
        <div class="row-between"><span id="call-status" class="muted small"></span><button class="btn small" id="hang-up">Hang up</button></div>
        <div class="bubbles-log" id="call-log"></div>
        <form id="call-type" class="reply-box"><input id="call-text" placeholder="Or type what the caller says…" autocomplete="off"><button class="btn btn-primary">Send</button></form>
      </div>
    </div>`);

  // ---------- Save voice engine ----------
  document.getElementById("engines").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const keys = {};
    for (const [n] of [...ENGINE_KEYS, ["custom"]]) if (f[`key-${n}`].value.trim()) keys[n] = f[`key-${n}`].value.trim();
    const voices = Object.fromEntries(langs.map((c) => [c, f[`voice-${c}`]?.value.trim() || ""]));
    try {
      await api("PUT", "/phone-voice/engines", { stt: f.stt.value, tts: f.tts.value, customTtsUrl: f.customTtsUrl.value.trim(), keys, voices });
      toast("Voice engine saved");
      reload();
    } catch (err) { toast(err.message); }
  };

  // ---------- Preview ----------
  document.getElementById("pv-play").onclick = async () => {
    const info = document.getElementById("pv-info");
    info.textContent = "Generating…";
    try {
      const res = await fetch("/api/phone-voice/preview", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ language: document.getElementById("pv-lang").value, text: document.getElementById("pv-text").value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Preview failed");
      const audio = new Audio(URL.createObjectURL(await res.blob()));
      info.textContent = `Voice: ${res.headers.get("x-voice-engine")} (8 kHz, as heard on a phone call)`;
      await audio.play();
    } catch (err) { info.textContent = err.message; }
  };

  // ---------- Phone companies ----------
  document.querySelectorAll(".carrier-card").forEach((form) => {
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const body = Object.fromEntries(new FormData(form).entries());
      try {
        const r = await api("PUT", `/phone-voice/carriers/${form.dataset.carrier}`, body);
        toast(r.ready ? "Connected" : "Saved: fill in every field to connect");
        reload();
      } catch (err) { toast(err.message); }
    };
  });

  // ---------- Numbers ----------
  document.getElementById("add-number").onsubmit = async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target).entries());
    try { await api("POST", "/phone-voice/numbers", body); toast("Number added: paste its URL in your phone company"); reload(); } catch (err) { toast(err.message); }
  };
  document.querySelectorAll("tr[data-id]").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector("[data-agent]").onchange = (ev) => api("PATCH", `/phone-voice/numbers/${id}`, { agentId: ev.target.value || null }).then(() => toast("Saved"), (err) => toast(err.message));
    row.querySelector("[data-out]").onchange = (ev) => api("PATCH", `/phone-voice/numbers/${id}`, { outbound: ev.target.checked }).then(() => toast("Saved"), (err) => toast(err.message));
    const del = row.querySelector("[data-del]");
    if (del) del.onclick = async () => {
      if (!confirm("Remove this number from VoiceDesk? Calls to it won't be answered by the AI.")) return;
      await api("DELETE", `/phone-voice/numbers/${id}`).catch((err) => toast(err.message));
      reload();
    };
  });
  document.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy).then(() => toast("Copied"))));

  // ---------- Try it ----------
  document.getElementById("ring-me").onclick = async () => {
    try { const r = await api("POST", "/phone-voice/test-call", { agentId: document.getElementById("try-agent").value }); toast(`Calling your phone via ${r.carrier}…`); } catch (err) { toast(err.message); }
  };
  let call = null;
  document.getElementById("web-call").onclick = async () => {
    if (call) return;
    try { call = await startBrowserCall(document.getElementById("try-agent").value, () => (call = null)); } catch (err) { toast(err.message); call = null; }
  };
  onLeave(() => call?.hangUp());
});

function reload() {
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

// ================= Browser call =================
const WORKLET = `
class Mic extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("vd-mic", Mic);`;

const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

async function startBrowserCall(agentId, onEnd) {
  const started = await api("POST", "/phone-voice/web-call", { agentId });
  const box = document.getElementById("call-box");
  const log = document.getElementById("call-log");
  const status = document.getElementById("call-status");
  box.hidden = false;
  log.innerHTML = "";
  const line = (role, text) => {
    if (!text) return;
    log.insertAdjacentHTML("beforeend", `<div class="b ${role === "caller" ? "caller" : "agent"}"><small>${role === "caller" ? "You" : "AI"}</small>${h(text)}</div>`);
    log.scrollTop = log.scrollHeight;
  };
  const browserEars = started.engines.stt === "browser";
  const browserMouth = started.engines.tts === "browser";
  status.textContent = `Connecting… ears: ${started.engines.stt}, voice: ${started.engines.tts}, language: ${started.language}`;

  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}${started.url}`);
  const ctx = new AudioContext();
  let nextAt = 0;
  let playing = [];
  let stream = null;
  let recognizer = null;
  let ended = false;
  let language = started.language;

  const stopPlayback = () => {
    playing.forEach((s) => { try { s.stop(); } catch {} });
    playing = [];
    nextAt = 0;
    speechSynthesis.cancel();
  };

  const hangUp = () => {
    if (ended) return;
    ended = true;
    try { ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ event: "stop" })); ws.close(); } catch {}
    stream?.getTracks().forEach((t) => t.stop());
    try { recognizer?.stop(); } catch {}
    stopPlayback();
    ctx.close().catch(() => {});
    status.textContent = "Call ended. You'll find it under Calls.";
    onEnd();
  };

  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.event === "media") {
      const bytes = unb64(msg.payload);
      const view = new DataView(bytes.buffer);
      const n = bytes.length / 2;
      const buf = ctx.createBuffer(1, n, 8000);
      const data = buf.getChannelData(0);
      for (let i = 0; i < n; i++) data[i] = view.getInt16(i * 2, true) / 32768;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      nextAt = Math.max(nextAt, ctx.currentTime + 0.05);
      src.start(nextAt);
      nextAt += buf.duration;
      playing.push(src);
      src.onended = () => (playing = playing.filter((s) => s !== src));
    } else if (msg.event === "say") {
      line("agent", msg.text);
      if (msg.language) language = msg.language;
      const u = new SpeechSynthesisUtterance(msg.text);
      u.lang = msg.language || language;
      speechSynthesis.speak(u);
    } else if (msg.event === "caption") line(msg.role, msg.text);
    else if (msg.event === "clear") stopPlayback();
    else if (msg.event === "transfer") line("agent", `(Transferring you to ${msg.number})`);
    else if (msg.event === "end") hangUp();
  };
  ws.onclose = () => hangUp();
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("Couldn't connect the call.")); });
  ws.send(JSON.stringify({ event: "start" }));
  status.textContent = `Live: ears ${started.engines.stt}, voice ${started.engines.tts}`;

  document.getElementById("hang-up").onclick = hangUp;
  document.getElementById("call-type").onsubmit = (ev) => {
    ev.preventDefault();
    const input = document.getElementById("call-text");
    const text = input.value.trim();
    if (!text || ended) return;
    ws.send(JSON.stringify({ event: "text", text }));
    input.value = "";
  };

  if (browserEars) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      status.textContent += " · This browser can't listen: type below instead.";
    } else {
      recognizer = new SR();
      recognizer.continuous = true;
      recognizer.interimResults = false;
      recognizer.lang = language;
      recognizer.onresult = (ev) => {
        const r = ev.results[ev.results.length - 1];
        const text = r[0].transcript.trim();
        if (!r.isFinal || !text || speechSynthesis.speaking) return; // don't transcribe the AI's own voice
        ws.send(JSON.stringify({ event: "text", text }));
      };
      recognizer.onend = () => { if (!ended) try { recognizer.lang = language; recognizer.start(); } catch {} };
      try { recognizer.start(); } catch {}
    }
  } else {
    // Stream the microphone to VoiceDesk's ears: 16-bit PCM at 8 kHz, ~100 ms per message.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
    const mic = new AudioWorkletNode(ctx, "vd-mic");
    ctx.createMediaStreamSource(stream).connect(mic);
    const ratio = ctx.sampleRate / 8000;
    let pending = [];
    let carry = 0;
    mic.port.onmessage = ({ data }) => {
      let pos = carry;
      for (; pos < data.length; pos += ratio) {
        const s = Math.max(-1, Math.min(1, data[Math.floor(pos)]));
        pending.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      }
      carry = pos - data.length;
      if (pending.length >= 800 && ws.readyState === WebSocket.OPEN) {
        const pcm = new Int16Array(pending);
        pending = [];
        ws.send(JSON.stringify({ event: "media", payload: b64(new Uint8Array(pcm.buffer)) }));
      }
    };
  }
  if (ctx.state === "suspended") await ctx.resume();
  return { hangUp };
}
