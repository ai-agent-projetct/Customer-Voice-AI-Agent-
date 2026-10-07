// Receptionists list and editor: basics, knowledge (with AI setup assistant
// and FAQs), services & hours, phone & website widget, and the Test Lab.
import { api, emptyState, h, pill, route, shell, state, toast } from "../core.js";
import { mountTestCall } from "../testcall.js";

route("agents", async () => {
  const agents = await api("GET", "/agents");
  const lang = (code) => state.catalog.languages.find((l) => l.code === code)?.name;
  shell("agents", `
    <div class="page-head"><div><h1>Receptionists</h1><p class="muted">Each receptionist answers one phone number and can also chat on your website.</p></div></div>
    ${agents.length ? `<div class="agent-cards">${agents.map((a) => `
      <div class="agent-card">
        <div class="row-between"><strong>${h(a.name)}</strong>${pill(a.active ? "Active" : "Paused", a.active ? "" : "grey")}</div>
        <span class="muted">${h([a.language, ...(a.languages || [])].map((c) => state.catalog.languages.find((l) => l.code === c)?.native).join(" · "))}<br>${a.phoneNumber ? h(a.phoneNumber) : "No number yet"}${a.widgetEnabled ? " · Website chat on" : ""}</span>
        <div class="actions"><a class="btn btn-primary" href="#agent/${h(a.id)}">Edit & test</a><a class="btn" href="#agent/${h(a.id)}/lab">Test Lab</a></div>
      </div>`).join("")}</div>` : ""}
    <div class="panel" style="margin-top:18px"><h2>${agents.length ? "Add another receptionist" : "Create your first receptionist"}</h2>
      <p class="muted">Start from a template for your type of business. Then use the AI setup assistant to fill it in from your website or notes.</p>
      <div class="templates">${state.catalog.templates.map((t) => `<button data-template="${h(t.id)}">${h(t.label)}</button>`).join("")}</div>
      <p class="error" id="err" role="alert"></p>
    </div>`);
  document.querySelectorAll("[data-template]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        const agent = await api("POST", "/agents", { templateId: btn.dataset.template });
        location.hash = `#agent/${agent.id}`;
      } catch (err) {
        document.getElementById("err").textContent = err.message;
      }
    };
  });
});

const TABS = ["Basics", "Languages & voice", "Knowledge", "Services & hours", "Phone & website", "Test Lab"];
const LAB = 5;

route("agent", async (id) => {
  const [agentId, tab] = id.split("/").length > 1 ? id.split("/") : [id, location.hash.split("/")[2]];
  const a = await api("GET", `/agents/${agentId}`);
  const { languages } = state.catalog;
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const startTab = tab === "lab" ? LAB : tab === "languages" ? 1 : 0;
  const premium = state.catalog.premiumVoice;
  const spokenNow = [a.language, ...(a.languages || [])];
  const embed = `<script src="${location.origin}/widget.js" data-agent="${a.publicId || ""}" async></script>`;

  shell("agents", `
    <div class="page-head"><div><a href="#agents">← Receptionists</a><h1>${h(a.name)}</h1></div></div>
    <div class="editor">
      <form class="panel" id="agent-form" novalidate>
        <div class="tabs" role="tablist">${TABS.map((t, i) => `<button type="button" role="tab" data-tab="${i}" class="${i === startTab ? "active" : ""}">${t}</button>`).join("")}</div>

        <div data-pane="0">
          <label>Name<input name="name" value="${h(a.name)}" required></label>
          <label>Greeting in the main language <span class="hint">— the first thing callers hear. Returning callers are also welcomed by name. Other languages: see "Languages & voice".</span><textarea name="greeting" style="min-height:70px">${h(a.greeting)}</textarea></label>
          <label class="check"><input type="checkbox" name="active" ${a.active ? "checked" : ""}> Answer calls (turn off to pause)</label>
        </div>

        <div data-pane="1" class="hidden">
          <div class="row">
            <label>Main language <span class="hint">— used when the caller doesn't choose</span><select name="language">${languages.map((l) => `<option value="${l.code}" ${l.code === a.language ? "selected" : ""}>${h(l.name)} · ${h(l.native)}</option>`).join("")}</select></label>
            <label>Voice<select name="voiceGender"><option value="female" ${a.voiceGender !== "male" ? "selected" : ""}>Female</option><option value="male" ${a.voiceGender === "male" ? "selected" : ""}>Male</option></select></label>
          </div>
          <div class="label">Also speaks <span class="hint">— callers can pick these, or just start speaking them</span></div>
          <div class="lang-grid" id="extra-langs">${languages.map((l) => `<label class="lang-chip"><input type="checkbox" name="extraLang" value="${l.code}" ${(a.languages || []).includes(l.code) ? "checked" : ""}><b>${h(l.native)}</b><span>${h(l.name)}</span></label>`).join("")}</div>
          <label class="check" style="margin-top:14px"><input type="checkbox" name="languageMenu" ${a.languageMenu !== false ? "checked" : ""}> Start phone calls with a language menu ("For English press 1, हिंदी के लिए 2 दबाइए…"). Returning callers skip it: their language is remembered.</label>
          <div class="row">
            <label>Speaking speed<select name="speakingRate">${[["slow", "Slower (good for elderly callers)"], ["normal", "Normal"], ["fast", "Faster"]].map(([v, t]) => `<option value="${v}" ${(a.speakingRate || "normal") === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
            <label>Voice quality<select name="voiceEngine"><option value="standard">Standard voices (all languages)</option><option value="premium" ${a.voiceEngine === "premium" ? "selected" : ""} ${premium.available ? "" : "disabled"}>Premium natural voice${premium.available ? "" : " (not set up on server)"}</option></select></label>
          </div>
          ${premium.available ? `<p class="muted small">Premium voice covers: ${h(premium.languages.map((c) => languages.find((l) => l.code === c)?.name || c).join(", "))}. Other languages use standard voices.</p>` : ""}
          <div class="row-between" style="margin-top:8px"><div class="label">Greeting and voice for each language</div><button type="button" class="btn small" id="translate">✨ Translate greetings with AI</button></div>
          <div id="lang-rows"></div>
        </div>

        <div data-pane="2" class="hidden">
          <div class="assistant">
            <b>✨ AI setup assistant</b>
            <p class="muted small">Paste your website or Google listing link, or your menu, price list or rough notes in any language. It writes your receptionist's knowledge for you to review.</p>
            <input id="af-url" placeholder="https://your-website.com (optional)">
            <textarea id="af-notes" placeholder="e.g. Haircut ₹300, beard trim ₹150. Open 10–8, closed Tuesday. Near Anna Nagar bus stand. UPI accepted." style="min-height:80px;margin-top:8px"></textarea>
            <button type="button" class="btn btn-primary" id="af-go" style="margin-top:8px">Build my receptionist</button>
            <div id="af-out"></div>
          </div>
          <label>About your business <span class="hint">— address, services, prices, timings, offers, policies. Write it like you'd brief a new employee.</span><textarea name="businessInfo" style="min-height:200px">${h(a.businessInfo)}</textarea></label>
          <label>Special instructions <span class="hint">— how it should behave, what it must never say</span><textarea name="instructions">${h(a.instructions)}</textarea></label>
          <div class="label">Answers you've taught it <span class="hint">— from "Teach it" or added here</span></div>
          <div id="faqs"></div>
          <button type="button" class="btn small" id="add-faq">+ Add question & answer</button>
        </div>

        <div data-pane="3" class="hidden">
          <label class="check"><input type="checkbox" name="bookingEnabled" ${a.bookingEnabled ? "checked" : ""}> Let callers book, check, cancel and reschedule appointments</label>
          <div class="label">Services and prices <span class="hint">— prices power your revenue report</span></div>
          <div id="services"></div>
          <button type="button" class="btn small" id="add-service">+ Add service</button>
          <div class="label" style="margin-top:16px">Open days</div>
          <div class="days">${dayNames.map((d, i) => `<label><input type="checkbox" name="day" value="${i}" ${a.hours.days.includes(i) ? "checked" : ""}>${d}</label>`).join("")}</div>
          <div class="row" style="margin-top:14px">
            <label>Opens<input type="time" name="open" value="${h(a.hours.open)}"></label>
            <label>Closes<input type="time" name="close" value="${h(a.hours.close)}"></label>
          </div>
          <div class="row">
            <label>Appointment length (minutes)<input type="number" name="slotMinutes" min="5" max="480" step="5" value="${a.hours.slotMinutes}"></label>
            <label>Time zone<input name="timeZone" value="${h(a.timeZone)}"></label>
          </div>
        </div>

        <div data-pane="4" class="hidden">
          <label>Phone number that rings this receptionist <span class="hint">— your Twilio number, e.g. +918045671234</span><input name="phoneNumber" value="${h(a.phoneNumber)}" placeholder="+91…"></label>
          <label>Transfer calls to <span class="hint">— staff mobile for "speak to a person" (otherwise your number from Settings)</span><input name="transferNumber" value="${h(a.transferNumber)}" placeholder="+91…"></label>
          <p class="muted small">See <a href="#settings">Settings → Phone setup</a> for connecting a number.</p>
          <hr>
          <label class="check"><input type="checkbox" name="widgetEnabled" ${a.widgetEnabled ? "checked" : ""}> Show a "Talk to us" voice & chat button on my website</label>
          <div id="embed" class="${a.widgetEnabled ? "" : "hidden"}">
            <p class="muted small">Paste this line just before <code>&lt;/body&gt;</code> on your website:</p>
            <pre class="code" id="embed-code">${h(embed)}</pre>
            <button type="button" class="btn small" id="copy-embed">Copy code</button>
          </div>
        </div>

        <div data-pane="5" class="hidden" id="lab"></div>

        <p class="error" id="err" role="alert"></p>
        <div class="save-bar" id="save-bar"><button class="btn btn-primary">Save changes</button><button type="button" class="btn btn-danger" id="delete">Delete</button></div>
      </form>
      <div class="phone">
        <h2>Test call</h2>
        <p class="muted">Talk to your receptionist like a customer would, with your microphone (Chrome works best) or by typing.</p>
        <div class="chat" id="chat"><div class="msg system">Press "Start test call" to begin.</div></div>
        <div class="phone-controls" id="controls"><select id="test-lang" aria-label="Language for the test call">${spokenNow.map((c) => `<option value="${c}">${h(languages.find((l) => l.code === c)?.native || c)}</option>`).join("")}</select><button class="btn btn-primary" id="start" style="flex:1">Start test call</button></div>
      </div>
    </div>`);

  const form = document.getElementById("agent-form");
  const showTab = (i) => {
    form.querySelectorAll("[data-tab]").forEach((t) => t.classList.toggle("active", Number(t.dataset.tab) === i));
    form.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("hidden", Number(p.dataset.pane) !== i));
    document.getElementById("save-bar").classList.toggle("hidden", i === LAB);
    if (i === LAB) renderLab(a);
  };
  form.querySelectorAll("[data-tab]").forEach((t) => (t.onclick = () => showTab(Number(t.dataset.tab))));
  // ---- Languages & voice ----
  const langName = (c) => languages.find((l) => l.code === c);
  const greetings = { ...(a.greetings || {}) };
  const voices = { ...(a.voices || {}) };
  if (a.voice && !voices[a.language]) voices[a.language] = a.voice; // older setting: one voice for the main language
  const enabled = () => [form.language.value, ...[...form.querySelectorAll("[name=extraLang]:checked")].map((c) => c.value).filter((c) => c !== form.language.value)];
  const rememberRows = () => {
    document.querySelectorAll("[data-greet]").forEach((t) => (greetings[t.dataset.greet] = t.value));
    document.querySelectorAll("[data-voice]").forEach((t) => (voices[t.dataset.voice] = t.value));
  };
  const drawLangRows = () => {
    const main = form.language.value;
    form.querySelectorAll("[name=extraLang]").forEach((c) => {
      c.disabled = c.value === main;
      c.closest("label").classList.toggle("is-main", c.value === main);
    });
    document.getElementById("lang-rows").innerHTML = enabled().map((code) => {
      const l = langName(code);
      const defaultVoice = l.voices[form.voiceGender.value];
      return `<div class="lang-row">
        <div class="lang-head"><b>${h(l.native)}</b> <span class="muted small">${h(l.name)}${code === main ? " · main language" : ""}</span>
          <button type="button" class="btn small" data-preview="${code}">▶ Preview</button></div>
        ${code === main
          ? `<p class="muted small">Greeting: set in Basics.</p>`
          : `<textarea data-greet="${code}" placeholder="Leave empty to use the built-in ${h(l.name)} greeting" style="min-height:52px">${h(greetings[code] || "")}</textarea>`}
        <input data-voice="${code}" placeholder="Voice: ${h(defaultVoice)} (default)" value="${h(voices[code] || "")}" aria-label="${h(l.name)} voice">
      </div>`;
    }).join("");
    document.querySelectorAll("[data-preview]").forEach((b) => (b.onclick = () => previewVoice(b.dataset.preview)));
  };
  // Browser preview: an approximation of the phone voice, using your device's voices.
  const previewVoice = (code) => {
    if (!("speechSynthesis" in window)) return toast("Your browser can't play voices");
    const text = code === form.language.value ? form.greeting.value : document.querySelector(`[data-greet="${code}"]`)?.value || langName(code).greeting.replace("{org}", state.org.name);
    const u = new SpeechSynthesisUtterance(text || form.greeting.value);
    u.lang = code;
    u.rate = { slow: 0.85, normal: 1, fast: 1.12 }[form.speakingRate.value];
    const match = speechSynthesis.getVoices().find((v) => v.lang.replace("_", "-") === code);
    if (match) u.voice = match;
    else toast("Your device has no voice for this language; phone calls will still use it.");
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  };
  form.language.onchange = () => { rememberRows(); drawLangRows(); };
  form.voiceGender.onchange = () => { rememberRows(); drawLangRows(); };
  document.getElementById("extra-langs").onchange = () => { rememberRows(); drawLangRows(); };
  document.getElementById("translate").onclick = async (e) => {
    rememberRows();
    e.target.disabled = true;
    try {
      if (!(await save())) return;
      const out = await api("POST", `/agents/${a.id}/translate-greetings`, { greeting: form.greeting.value });
      Object.assign(greetings, out.greetings);
      drawLangRows();
      toast(out.demo ? "Filled with built-in greetings (demo mode). Review, then Save." : "Greetings translated. Review, then Save.");
    } catch (err) {
      toast(err.message);
    } finally {
      e.target.disabled = false;
    }
  };
  drawLangRows();
  form.widgetEnabled.onchange = () => document.getElementById("embed").classList.toggle("hidden", !form.widgetEnabled.checked);
  document.getElementById("copy-embed").onclick = () => navigator.clipboard?.writeText(document.getElementById("embed-code").textContent).then(() => toast("Copied"));

  // Repeating rows for FAQs and services.
  const faqBox = document.getElementById("faqs");
  const addFaq = (f = { q: "", a: "" }) => faqBox.insertAdjacentHTML("beforeend", `<div class="pair"><input data-q placeholder="Question" value="${h(f.q)}"><textarea data-a placeholder="Answer" style="min-height:44px">${h(f.a)}</textarea><button type="button" class="x" aria-label="Remove">×</button></div>`);
  const svcBox = document.getElementById("services");
  const addSvc = (s = { name: "", price: 0 }) => svcBox.insertAdjacentHTML("beforeend", `<div class="pair svc"><input data-name placeholder="Service" value="${h(s.name)}"><input data-price type="number" min="0" placeholder="₹ price" value="${s.price || ""}"><button type="button" class="x" aria-label="Remove">×</button></div>`);
  (a.faqs || []).forEach(addFaq);
  a.services.forEach(addSvc);
  form.onclick = (e) => { if (e.target.classList.contains("x")) e.target.parentElement.remove(); };
  document.getElementById("add-faq").onclick = () => addFaq();
  document.getElementById("add-service").onclick = () => addSvc();

  // AI setup assistant: fills the form for review; nothing is saved until "Save".
  document.getElementById("af-go").onclick = async (e) => {
    const out = document.getElementById("af-out");
    e.target.disabled = true;
    out.innerHTML = `<p class="muted">Reading and writing your setup… this can take up to a minute.</p>`;
    try {
      const p = await api("POST", `/agents/${a.id}/autofill`, { url: document.getElementById("af-url").value.trim(), notes: document.getElementById("af-notes").value });
      form.businessInfo.value = p.businessInfo;
      form.greeting.value = p.greeting;
      form.instructions.value = p.instructions;
      if (p.services?.length) { svcBox.innerHTML = ""; p.services.forEach(addSvc); }
      p.faqs?.forEach(addFaq);
      out.innerHTML = `<p class="ok">✓ Filled in ${p.services?.length || 0} services and ${p.faqs?.length || 0} FAQs${p.demo ? " (demo mode: basic extraction only)" : ""}. Review the tabs, then press Save.</p>`;
    } catch (err) {
      out.innerHTML = `<p class="error">${h(err.message)}</p>`;
    }
    e.target.disabled = false;
  };

  const collect = () => ({
    name: form.name.value.trim(),
    language: form.language.value,
    languages: enabled().slice(1),
    languageMenu: form.languageMenu.checked,
    voiceGender: form.voiceGender.value,
    speakingRate: form.speakingRate.value,
    voiceEngine: form.voiceEngine.value,
    voice: "",
    greetings: (rememberRows(), Object.fromEntries(Object.entries(greetings).filter(([c, t]) => t && enabled().includes(c)))),
    voices: Object.fromEntries(Object.entries(voices).filter(([c, v]) => v && enabled().includes(c))),
    greeting: form.greeting.value.trim(),
    active: form.active.checked,
    businessInfo: form.businessInfo.value,
    instructions: form.instructions.value,
    faqs: [...faqBox.querySelectorAll(".pair")].map((p) => ({ q: p.querySelector("[data-q]").value, a: p.querySelector("[data-a]").value })),
    bookingEnabled: form.bookingEnabled.checked,
    services: [...svcBox.querySelectorAll(".pair")].map((p) => ({ name: p.querySelector("[data-name]").value, price: Number(p.querySelector("[data-price]").value) || 0 })),
    hours: {
      days: [...form.querySelectorAll("[name=day]:checked")].map((c) => Number(c.value)),
      open: form.open.value,
      close: form.close.value,
      slotMinutes: Number(form.slotMinutes.value) || 30,
    },
    timeZone: form.timeZone.value.trim() || "Asia/Kolkata",
    phoneNumber: form.phoneNumber.value.trim(),
    transferNumber: form.transferNumber.value.trim(),
    widgetEnabled: form.widgetEnabled.checked,
  });
  const save = async () => {
    document.getElementById("err").textContent = "";
    try {
      Object.assign(a, await api("PUT", `/agents/${a.id}`, collect()));
      document.getElementById("embed-code").textContent = `<script src="${location.origin}/widget.js" data-agent="${a.publicId}" async></script>`;
      return true;
    } catch (err) {
      document.getElementById("err").textContent = err.message;
      return false;
    }
  };
  form.onsubmit = async (e) => { e.preventDefault(); if (await save()) toast("Saved"); };
  document.getElementById("delete").onclick = async () => {
    if (!confirm(`Delete ${a.name}? Its call history stays in Calls.`)) return;
    await api("DELETE", `/agents/${a.id}`);
    location.hash = "#agents";
  };
  mountTestCall(a, save, () => document.getElementById("test-lang").value);
  const refreshTestLangs = () => {
    const sel = document.getElementById("test-lang");
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = enabled().map((c) => `<option value="${c}" ${c === keep ? "selected" : ""}>${h(langName(c).native)}</option>`).join("");
  };
  form.addEventListener("change", refreshTestLangs);
  showTab(startTab);
});

// ---------- Test Lab ----------
async function renderLab(agent) {
  const box = document.getElementById("lab");
  const { personas } = state.catalog;
  const draw = async () => {
    const runs = await api("GET", `/agents/${agent.id}/simulations`);
    const latest = runs[0];
    const running = latest?.status === "running";
    const verdict = (s) => (s >= 90 ? ["Excellent", ""] : s >= 75 ? ["Ready", ""] : s >= 50 ? ["Needs work", "warm"] : ["Not ready", "bad"]);
    box.innerHTML = `
      <p class="muted">The Test Lab phones your receptionist as tough customers, then an AI examiner grades every conversation. Save your changes first: it tests the saved version.</p>
      <div class="personas">${personas.map((p) => `<label class="persona"><input type="checkbox" value="${p.id}" checked><b>${h(p.label)}</b><span class="muted small">${h(p.brief)}</span></label>`).join("")}</div>
      <button type="button" class="btn btn-primary" id="run-lab" ${running ? "disabled" : ""}>${running ? "Testing… (about a minute)" : "Run readiness test"}</button>
      ${latest?.status === "failed" ? `<p class="error">Last test failed: ${h(latest.error)}</p>` : ""}
      ${latest?.status === "done" ? `
        <div class="score"><div class="ring" style="--p:${latest.score}"><b>${latest.score}</b></div><div><h2>Readiness score: ${verdict(latest.score)[0]}</h2><p class="muted">${latest.demo ? "Demo mode: scores are illustrative until an API key is added." : "Fix the problems below, save, and run the test again."}</p></div></div>
        ${latest.results.map((r) => `
          <details class="lab-result" ${r.grade.score < 75 ? "open" : ""}>
            <summary><b>${h(r.label)}</b> ${pill(`${r.grade.score}/100`, verdict(r.grade.score)[1])}</summary>
            ${r.grade.problems.length ? `<p><b>Problems</b></p><ul>${r.grade.problems.map((x) => `<li>${h(x)}</li>`).join("")}</ul>` : ""}
            ${r.grade.fixes.length ? `<p><b>Suggested fixes</b></p><ul class="fixes">${r.grade.fixes.map((x) => `<li>${h(x)}</li>`).join("")}</ul>` : ""}
            ${r.grade.went_well.length ? `<p><b>Went well</b></p><ul>${r.grade.went_well.map((x) => `<li>${h(x)}</li>`).join("")}</ul>` : ""}
            ${r.actions.length ? `<p class="muted small">Actions taken: ${h(r.actions.join("; "))}</p>` : ""}
            <div class="transcript compact">${r.transcript.map((t) => `<div class="line ${t.role}"><span class="who">${t.role === "agent" ? "AI" : "Caller"}</span><span>${h(t.text)}</span></div>`).join("")}</div>
          </details>`).join("")}` : ""}
      ${!latest ? emptyState("No tests yet. Run one before connecting a real phone number.") : ""}`;
    document.getElementById("run-lab").onclick = async () => {
      const chosen = [...box.querySelectorAll(".persona input:checked")].map((i) => i.value);
      try { await api("POST", `/agents/${agent.id}/simulations`, { personas: chosen }); renderLab(agent); } catch (e) { toast(e.message); }
    };
    return running;
  };
  if (await draw()) {
    const poll = setInterval(async () => {
      if (!document.getElementById("lab") || !(await draw())) clearInterval(poll);
    }, 2500);
  }
}
