// Voice API: program calls on VoiceDesk Network. Numbers and where their
// calls go, a flow tester that rings your phone, recent calls with their
// steps, recordings, and this month's minutes and bill.
import { api, emptyState, fmtDate, h, pill, route, shell, state, toast } from "../core.js";

const TEMPLATES = {
  order: { label: "Order update with a keypad menu", flow: [
    { say: "Hello! Your order 1042 is ready for pickup." },
    { gather: { numDigits: 1, timeout: 5, prompt: [{ say: "Press 1 to talk to the shop. Press 2 to hear this again." }],
      options: { "1": [{ say: "Connecting you now." }, { dial: { number: "+919845000001" } }], "2": [{ redirect: "https://your.app/voice/order" }] } } },
    { say: "Thank you. Goodbye." },
    { hangup: true },
  ] },
  ivr: { label: "Main menu (IVR) with the AI receptionist", flow: [
    { say: "Welcome to Glow Salon." },
    { gather: { numDigits: 1, timeout: 6, prompt: [{ say: "Press 1 to book with our assistant. Press 2 to leave a message." }],
      options: { "1": [{ ai: {} }], "2": [{ say: "Please leave a message after the tone. Press hash when you are done." }, { record: { maxSeconds: 60, finishOnKey: "#" } }, { say: "Thank you, we will call you back." }] },
      noInput: [{ ai: {} }] } },
  ] },
  voicemail: { label: "After-hours voicemail", flow: [
    { say: "We are closed right now. Please leave your name and number after the tone." },
    { record: { maxSeconds: 90, finishOnKey: "#" } },
    { say: "Thank you. We will call you back tomorrow morning." },
    { hangup: true },
  ] },
  reminder: { label: "Appointment reminder in Hindi", flow: [
    { say: "नमस्ते! कल सुबह 11 बजे आपकी अपॉइंटमेंट है।", language: "hi-IN" },
    { gather: { numDigits: 1, timeout: 5, prompt: [{ say: "पुष्टि के लिए 1 दबाएँ, बदलने के लिए 2 दबाएँ।", language: "hi-IN" }],
      options: { "1": [{ say: "धन्यवाद, आपकी अपॉइंटमेंट पक्की है।", language: "hi-IN" }], "2": [{ ai: {} }] } } },
  ] },
};

route("voiceapi", async () => {
  const v = await api("GET", "/voice-platform");
  const base = location.origin;
  const statusPill = (c) => pill(c.status === "completed" ? c.outcome || "completed" : c.status, c.status === "completed" ? (c.outcome === "completed" ? "" : "grey") : "warm");

  shell("voiceapi", `
    <div class="page-head"><div><h1>Voice API</h1>
      <p class="muted">Program phone calls on VoiceDesk Network, our own telephony: keypad menus, voicemail, connecting calls, reminders, or handing calls to your AI receptionist. Developers use the same steps through the API.</p></div>
      <a class="btn" href="#developers">API keys</a></div>

    <div class="stats">
      <div class="stat"><span class="muted small">This month's calls</span><b>${v.usage.calls}</b></div>
      <div class="stat"><span class="muted small">Minutes in / out</span><b>${v.usage.inboundMinutes} / ${v.usage.outboundMinutes}</b></div>
      <div class="stat"><span class="muted small">Bill so far</span><b>₹${v.usage.costInr.toFixed(2)}</b></div>
      <div class="stat"><span class="muted small">Price per minute</span><b class="small-num">₹${v.usage.rates.inbound.toFixed(2)} in · ₹${v.usage.rates.outbound.toFixed(2)} out</b></div>
    </div>
    ${v.network.enabled ? "" : `<div class="banner">VoiceDesk Network isn't switched on yet on this server, so test calls can't ring. You can still build and check flows here. See docs/TELEPHONY-PLATFORM.md.</div>`}

    <div class="panel">
      <h2>Your numbers</h2>
      ${v.numbers.length ? v.numbers.map((n) => `
        <form class="number-row" data-id="${h(n.id)}">
          <div><b>${h(n.number)}</b>${n.label ? ` <span class="muted small">${h(n.label)}</span>` : ""}<br>
            ${n.voiceUrl ? pill("Calls go to your app", "warm") : pill("Calls go to the AI receptionist", "")}</div>
          <label class="small">Voice URL (empty = AI receptionist)<input name="voiceUrl" value="${h(n.voiceUrl)}" placeholder="https://your.app/voice/answer"></label>
          <label class="small">Status callback<input name="statusCallback" value="${h(n.statusCallback)}" placeholder="https://your.app/voice/status"></label>
          <label class="check small"><input type="checkbox" name="record" ${n.record ? "checked" : ""}> Record calls</label>
          <button class="btn small btn-primary">Save</button>
        </form>`).join("") : emptyState("No VoiceDesk Network numbers yet. The VoiceDesk team gives these out from the admin console.")}
    </div>

    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>Flow tester</h2>
          <select id="tpl" aria-label="Start from">${Object.entries(TEMPLATES).map(([k, t]) => `<option value="${k}">${h(t.label)}</option>`).join("")}</select></div>
        <p class="muted small">A flow is a list of steps: say, play, pause, gather (keypad menu), dial (connect), record, ai (hand to your receptionist), redirect and hangup. The test call rings your own phone (${h(v.ownerPhone || "add it in Settings")}).</p>
        <textarea id="flow" rows="16" spellcheck="false" class="code-input"></textarea>
        <div class="row-between" style="margin-top:10px">
          <span id="flow-check" class="small"></span>
          <span class="actions"><label class="check small"><input type="checkbox" id="flow-record"> Record</label>
            <button class="btn" id="check">Check</button><button class="btn btn-primary" id="ring">📞 Call my phone</button></span>
        </div>
        <div id="live" class="small" style="margin-top:10px"></div>
      </div>
      <div class="panel">
        <h2>Use it from your code</h2>
        <pre class="code">curl -X POST ${h(base)}/api/v1/voice/calls \\
  -H "Authorization: Bearer vd_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"to": "+9198XXXXXXXX",
       "record": true,
       "status_callback": "https://your.app/voice/status",
       "flow": [{"say": "Your order is ready."},
                {"hangup": true}]}'</pre>
        <p class="muted small">Or send <code>answer_url</code> and return the flow from your server when the call is answered. Full reference: <code>docs/VOICE-API.md</code>.</p>
      </div>
    </div>

    <div class="panel">
      <h2>Recent calls</h2>
      ${v.calls.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Direction</th><th>Number</th><th>Handled by</th><th>Status</th><th>Talk</th><th>Cost</th><th>Steps</th></tr></thead><tbody>
        ${v.calls.map((c) => `<tr><td>${fmtDate(c.created_at)}</td><td>${c.direction === "outbound" ? "Out" : "In"}</td><td>${h(c.direction === "outbound" ? c.to : c.from)}</td>
          <td>${c.handled_by === "flow" ? "Your flow" : "AI receptionist"}</td><td>${statusPill(c)}</td>
          <td>${c.talk_seconds != null ? `${c.talk_seconds}s` : "—"}</td><td>${c.cost_inr != null ? `₹${c.cost_inr.toFixed(2)}` : "—"}</td>
          <td class="small">${c.error ? `<span class="bad-text">${h(c.error)}</span>` : h(c.events.map((e) => e.step).filter(Boolean).join(" → ")) || "—"}</td></tr>`).join("")}
      </tbody></table></div>` : emptyState("No calls on VoiceDesk Network yet.")}
    </div>

    <div class="panel">
      <h2>Recordings</h2>
      ${v.recordings.length ? `<ul class="taught">${v.recordings.map((r) => `<li><b>${r.kind === "message" ? "Voicemail" : "Call"}</b> · ${r.seconds}s · <span class="muted small">${fmtDate(r.createdAt)}</span>
        <button class="btn small" data-play="${h(r.id)}">▶ Play</button></li>`).join("")}</ul>` : emptyState("Recordings of calls and voicemails appear here.")}
    </div>`);

  // ---- Numbers ----
  document.querySelectorAll(".number-row").forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("PATCH", `/voice-platform/numbers/${form.dataset.id}`, { voiceUrl: form.voiceUrl.value.trim(), statusCallback: form.statusCallback.value.trim(), record: form.record.checked });
        toast("Saved");
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      } catch (err) { toast(err.message); }
    };
  });

  // ---- Flow tester ----
  const box = document.getElementById("flow");
  const tpl = document.getElementById("tpl");
  const fill = () => (box.value = JSON.stringify(TEMPLATES[tpl.value].flow, null, 2));
  const out = document.getElementById("flow-check");
  tpl.onchange = () => { fill(); out.textContent = ""; };
  box.oninput = () => (out.textContent = "");
  fill();
  const parsed = () => {
    try { return JSON.parse(box.value); } catch (err) { throw new Error(`Not valid JSON: ${err.message}`); }
  };
  document.getElementById("check").onclick = async () => {
    try {
      const r = await api("POST", "/voice-platform/validate", { flow: parsed() });
      out.innerHTML = r.ok ? `<span class="ok-text">✅ Flow looks good (${countSteps(parsed())} steps).</span>` : `<span class="bad-text">${h(r.problem)}</span>`;
    } catch (err) { out.innerHTML = `<span class="bad-text">${h(err.message)}</span>`; }
  };
  document.getElementById("ring").onclick = async () => {
    try {
      const call = await api("POST", "/voice-platform/test-flow", { flow: parsed(), record: document.getElementById("flow-record").checked });
      toast("Calling your phone…");
      follow(call.id);
    } catch (err) { out.innerHTML = `<span class="bad-text">${h(err.message)}</span>`; }
  };

  // ---- Recordings (fetched with your login, played in the page) ----
  document.querySelectorAll("[data-play]").forEach((b) => (b.onclick = async () => {
    const res = await fetch(`/api/voice-platform/recordings/${b.dataset.play}`, { headers: { authorization: `Bearer ${state.token}` } });
    if (!res.ok) return toast("Recording not available");
    new Audio(URL.createObjectURL(await res.blob())).play();
  }));
});

function countSteps(flow) {
  let n = 0;
  const walk = (steps) => steps.forEach((s) => {
    n++;
    if (s.gather?.prompt) walk(s.gather.prompt);
    Object.values(s.gather?.options || {}).forEach(walk);
    if (s.gather?.noInput) walk(s.gather.noInput);
  });
  if (Array.isArray(flow)) walk(flow);
  return n;
}

/** Show the test call's progress until it ends. */
async function follow(id) {
  const live = document.getElementById("live");
  for (let i = 0; i < 300; i++) {
    if (!live.isConnected) return;
    const c = await api("GET", `/voice-platform/calls/${id}`).catch(() => null);
    if (!c) return;
    live.innerHTML = `<b>Test call:</b> ${h(c.status)}${c.outcome ? ` (${h(c.outcome)})` : ""} · steps: ${h(c.events.map((e) => e.step || (e.error ? `error: ${e.error}` : "")).filter(Boolean).join(" → ") || "waiting for answer")}${c.cost_inr != null ? ` · ₹${c.cost_inr.toFixed(2)}` : ""}`;
    if (c.status === "completed") return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
