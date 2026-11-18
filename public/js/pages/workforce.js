// AI workforce pages: Team, Inbox (human takeover), Company Brain,
// Automations, Activity & Approvals.
import { api, emptyState, every, fmtDate, h, pill, route, rupees, shell, state, toast } from "../core.js";

const CHANNEL = { whatsapp: "WhatsApp", instagram: "Instagram", messenger: "Messenger", widget: "Website", phone: "Phone" };
const CH_TONE = { whatsapp: "", instagram: "hot", messenger: "grey", widget: "warm", phone: "grey" };

// ---------- AI workforce ----------
route("team", async () => {
  const t = await api("GET", "/team");
  shell("team", `
    <div class="page-head"><div><h1>AI workforce</h1><p class="muted">Your AI employees, what each one is allowed to do, and what they did in the last 24 hours.</p></div>
      <a class="btn btn-primary" href="#agents">Add an AI employee</a></div>
    <div class="agent-cards">${t.agents.map((a) => `
      <div class="agent-card">
        <div class="row-between"><strong>${h(a.name)}</strong>${pill(a.active ? "On duty" : "Paused", a.active ? "" : "grey")}</div>
        <span class="muted">${h(t.roles[a.role]?.label || "Assistant")}</span>
        <div class="chips">${a.channels.map((c) => pill(CHANNEL[c] || c, CH_TONE[c])).join(" ") || `<span class="muted small">No channels connected</span>`}</div>
        <p class="small" style="margin:6px 0 0">${a.conversationsToday} conversation${a.conversationsToday === 1 ? "" : "s"} today${a.live ? ` · <b>${a.live} live</b>` : ""} · ${a.actionsToday} action${a.actionsToday === 1 ? "" : "s"}</p>
        ${a.lastAction ? `<p class="muted small" style="margin:0">Last: ${h(a.lastAction.tool.replace(/_/g, " "))} · ${fmtDate(a.lastAction.createdAt)}</p>` : ""}
        <div class="actions"><a class="btn" href="#agent/${h(a.id)}">Job & permissions</a><a class="btn" href="#activity?agent=${h(a.id)}">Activity</a></div>
      </div>`).join("")}</div>
    ${t.agents.length > 1 ? `<div class="banner" style="margin-top:18px">🤝 Your AI employees hand conversations to each other when another one's job fits better (for example Sales → Support), with the full history.</div>` : ""}`);
});

// ---------- Inbox ----------
route("inbox", async (id) => {
  const filter = new URLSearchParams(location.hash.split("?")[1] || "").get("filter") || "open";
  shell("inbox", `
    <div class="page-head"><div><h1>Inbox</h1><p class="muted">Every chat on WhatsApp, Instagram, Messenger and your website. Take over any conversation; the AI steps aside until you hand it back.</p></div>
      <div class="chips">${[["open", "Open"], ["human", "With the team"], ["all", "All"]].map(([f, l]) => `<a class="btn small ${f === filter ? "btn-primary" : ""}" href="#inbox?filter=${f}">${l}</a>`).join("")}</div></div>
    <div class="inbox"><div class="panel conv-list" id="conv-list"></div><div class="panel conv" id="conv">${emptyState("Choose a conversation.")}</div></div>`);
  let openId = id?.split("?")[0] || null;
  let lastCount = -1;

  const drawList = async () => {
    const rows = await api("GET", `/inbox?filter=${filter}`);
    const box = document.getElementById("conv-list");
    if (!box) return;
    box.innerHTML = rows.length
      ? rows.map((c) => `<button class="conv-row ${c.id === openId ? "active" : ""}" data-id="${h(c.id)}">
          <span class="row-between"><b>${h(c.customer)}</b><small class="muted">${fmtDate(c.lastAt)}</small></span>
          <span class="chips">${pill(CHANNEL[c.channel], CH_TONE[c.channel])} ${c.needsPerson ? pill("Wants a person", "bad") : c.humanMode ? pill("You're handling", "warm") : pill(`AI: ${c.agentName}`, "grey")} ${c.unread ? `<span class="dot" title="Unread"></span>` : ""}</span>
          <span class="muted small one-line">${h(c.lastLine)}</span></button>`).join("")
      : emptyState("No conversations yet. Connect WhatsApp, Instagram or Messenger on an AI employee, or turn on the website chat.");
    box.querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => { openId = b.dataset.id; lastCount = -1; drawList(); drawConv(); }));
  };

  const drawConv = async () => {
    if (!openId) return;
    const c = await api("GET", `/inbox/${openId}`);
    const box = document.getElementById("conv");
    if (!box) return;
    const typing = document.getElementById("reply-text")?.value || "";
    if (c.transcript.length === lastCount && document.getElementById("reply-text")) return; // nothing new: keep what the owner is typing
    lastCount = c.transcript.length;
    const who = { agent: c.agentName || "AI", human: "You", caller: c.customer?.name || "Customer" };
    box.innerHTML = `
      <div class="panel-head"><div><b>${h(c.customer?.name || c.customerName || c.callerNumber || "Website visitor")}</b> ${pill(CHANNEL[c.channel], CH_TONE[c.channel])}
        <br><span class="muted small">${h(c.callerNumber || "")}${c.customer?.preferredLanguage ? ` · ${h(c.customer.preferredLanguage)}` : ""}${c.handoffs?.length ? ` · handed: ${c.handoffs.map((x) => `${h(x.from)} → ${h(x.to)}`).join(", ")}` : ""}</span></div>
        <div>${c.status === "ended" ? pill("Closed", "grey") : c.humanMode
          ? `<button class="btn" id="release">Hand back to AI</button>`
          : `<button class="btn btn-primary" id="takeover">Take over</button>`} ${c.status !== "ended" ? `<button class="btn small" id="close">Close</button>` : ""}</div></div>
      ${c.orders?.length ? `<div class="chips" style="margin-bottom:8px">${c.orders.map((o) => pill(`Order ${o.ref} · ${rupees(o.total)} · ${o.status.replace(/_/g, " ")}`, "grey")).join(" ")}</div>` : ""}
      <div class="bubbles-log" id="log">${c.transcript.map((t) => `<div class="b ${t.role}"><small>${h(t.role === "human" ? `${t.by || "Team"} (you)` : who[t.role] || t.role)}</small>${h(t.text)}</div>`).join("")}</div>
      ${c.status !== "ended" ? `<form id="reply" class="reply-box"><textarea id="reply-text" placeholder="${c.humanMode ? "Reply as yourself…" : "Type to take over and reply…"}" rows="2">${h(typing)}</textarea><button class="btn btn-primary">Send</button></form>` : ""}`;
    const log = document.getElementById("log");
    log.scrollTop = log.scrollHeight;
    const act = (path, msg) => async () => { await api("POST", `/inbox/${openId}/${path}`); toast(msg); lastCount = -1; drawConv(); drawList(); };
    document.getElementById("takeover")?.addEventListener("click", act("takeover", "You're handling this conversation. The AI will stay quiet."));
    document.getElementById("release")?.addEventListener("click", act("release", "Handed back to the AI"));
    document.getElementById("close")?.addEventListener("click", act("close", "Conversation closed"));
    const form = document.getElementById("reply");
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const text = document.getElementById("reply-text").value.trim();
      if (!text) return;
      try {
        const out = await api("POST", `/inbox/${openId}/reply`, { text });
        document.getElementById("reply-text").value = "";
        if (out.delivered === "not_configured") toast("Saved, but this channel isn't connected yet, so it wasn't delivered.");
        lastCount = -1;
        drawConv();
        drawList();
      } catch (err) { toast(err.message); }
    };
  };
  await drawList();
  if (openId) await drawConv();
  every(4000, async () => { await drawList(); await drawConv(); });
});

// ---------- Company Brain ----------
route("brain", async () => {
  const docs = await api("GET", "/brain");
  shell("brain", `
    <div class="page-head"><div><h1>Company Brain</h1><p class="muted">Everything your business knows, in one place. <b>Public</b> documents help your AI employees answer customers; <b>internal</b> ones stay with you and your team. Call and chat summaries are added automatically.</p></div></div>
    <div class="panel ask">
      <form id="ask" class="row-between" style="gap:10px;align-items:flex-end"><label style="flex:1;margin:0">Ask your business anything<input name="q" placeholder="e.g. What did customers complain about this week? What's our return policy?"></label><button class="btn btn-primary">Ask</button></form>
      <div id="answer"></div>
      <p class="muted small">Tip: message your own business WhatsApp number from your mobile (Settings → Your mobile) to ask the Brain on the go.</p>
    </div>
    <div class="grid-2">
      <div class="panel"><h2>Documents (${docs.length})</h2>
        ${docs.length ? `<ul class="taught">${docs.map((d) => `<li><b>${h(d.title)}</b> ${pill(d.visibility, d.visibility === "public" ? "" : "grey")} <small class="muted">${d.words} words · ${fmtDate(d.createdAt)}</small><br><span class="muted small">${h(d.preview)}…</span>
          <br><button class="btn small" data-vis="${h(d.id)}" data-to="${d.visibility === "public" ? "internal" : "public"}">Make ${d.visibility === "public" ? "internal" : "public"}</button> <button class="btn small btn-danger" data-del="${h(d.id)}">Delete</button></li>`).join("")}</ul>`
          : emptyState("No documents yet. Add your price list, policies, product details or meeting notes.")}
      </div>
      <form class="panel" id="add"><h2>Add knowledge</h2>
        <label>Title<input name="title" required placeholder="Return policy"></label>
        <label>Text <span class="hint">— paste it, or load a .txt / .md file</span><textarea name="content" required style="min-height:160px"></textarea></label>
        <input type="file" id="file" accept=".txt,.md,.csv,text/plain,text/markdown" style="margin-bottom:12px">
        <label class="check"><input type="radio" name="visibility" value="public" checked> Public: customers may be told this</label>
        <label class="check"><input type="radio" name="visibility" value="internal"> Internal: only you and your team</label>
        <p class="error" id="err" role="alert"></p>
        <div class="save-bar"><button class="btn btn-primary">Add to Brain</button></div>
      </form>
    </div>`);
  document.getElementById("file").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 200_000) return toast("That file is too big (200 KB max).");
    const form = document.getElementById("add");
    form.content.value = await f.text();
    if (!form.title.value) form.title.value = f.name.replace(/\.[^.]+$/, "");
  };
  document.getElementById("add").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api("POST", "/brain", { title: f.title.value, content: f.content.value, visibility: f.querySelector("[name=visibility]:checked").value, source: "upload" });
      toast("Added to your Company Brain");
      location.reload();
    } catch (err) { document.getElementById("err").textContent = err.message; }
  };
  document.getElementById("ask").onsubmit = async (e) => {
    e.preventDefault();
    const out = document.getElementById("answer");
    out.innerHTML = `<p class="muted">Thinking…</p>`;
    try {
      const a = await api("POST", "/brain/ask", { question: e.target.q.value });
      out.innerHTML = `<div class="banner ok" style="white-space:pre-wrap">${h(a.answer)}</div>${a.sources.length ? `<p class="muted small">Sources: ${a.sources.map((s) => `[${s.n}] ${s.callId ? `<a href="#call/${h(s.callId)}">${h(s.title)}</a>` : h(s.title)}`).join(" · ")}</p>` : ""}`;
    } catch (err) { out.innerHTML = `<p class="error">${h(err.message)}</p>`; }
  };
  document.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => { if (confirm("Delete this document?")) { await api("DELETE", `/brain/${b.dataset.del}`); location.reload(); } }));
  document.querySelectorAll("[data-vis]").forEach((b) => (b.onclick = async () => { await api("PUT", `/brain/${b.dataset.vis}`, { visibility: b.dataset.to }); location.reload(); }));
});

// ---------- Automations ----------
route("automations", async () => {
  const { settings: s, waiting } = await api("GET", "/automations");
  const card = (key, title, desc, body, count) => `
    <form class="panel auto" data-key="${key}">
      <div class="panel-head"><div><h2>${title}</h2><p class="muted small" style="margin:0">${desc}</p></div>
        <label class="switch"><input type="checkbox" name="enabled" ${s[key].enabled ? "checked" : ""}><span>${s[key].enabled ? "On" : "Off"}</span></label></div>
      ${body}
      <div class="row-between"><span class="muted small">${count}</span><button class="btn small btn-primary">Save</button></div>
    </form>`;
  shell("automations", `
    <div class="page-head"><div><h1>Automations</h1><p class="muted">Jobs your AI employees do by themselves. Messages and calls only go out between 9am and 9pm, never to do-not-call numbers, and calls only to people who agreed.</p></div></div>
    <div class="grid-2">
    ${card("codConfirm", "Confirm cash-on-delivery orders", "New COD orders from your website get a WhatsApp asking YES/NO; if there's no reply, the AI calls (with consent). Cuts fake orders and returns.",
      `<div class="row"><label>WhatsApp after (minutes)<input type="number" name="messageAfterMinutes" min="1" value="${s.codConfirm.messageAfterMinutes}"></label><label>Call if no reply after (minutes)<input type="number" name="callAfterMinutes" min="1" value="${s.codConfirm.callAfterMinutes}"></label></div>`,
      `${waiting.codOrders} order${waiting.codOrders === 1 ? "" : "s"} waiting for confirmation`)}
    ${card("abandonedCart", "Recover abandoned carts", "A WhatsApp reminder with the checkout link, then a friendly AI call to help with questions.",
      `<div class="row"><label>WhatsApp after (minutes)<input type="number" name="messageAfterMinutes" min="1" value="${s.abandonedCart.messageAfterMinutes}"></label><label>Call after (minutes)<input type="number" name="callAfterMinutes" min="1" value="${s.abandonedCart.callAfterMinutes}"></label></div>`,
      `${waiting.carts} cart${waiting.carts === 1 ? "" : "s"} not recovered yet`)}
    ${card("leadFollowUp", "Follow up on every lead", "New leads get follow-ups until someone marks them contacted, won or lost. Nobody slips through.",
      `<div id="steps">${s.leadFollowUp.steps.map((st, i) => `<div class="row step"><label>Step ${i + 1}: after (hours)<input type="number" data-hours min="0" value="${st.afterHours}"></label><label>by<select data-ch><option value="whatsapp" ${st.channel === "whatsapp" ? "selected" : ""}>WhatsApp</option><option value="call" ${st.channel === "call" ? "selected" : ""}>AI call</option></select></label></div>`).join("")}</div>`,
      `${waiting.leads} lead${waiting.leads === 1 ? "" : "s"} in the sequence`)}
    </div>
    <div class="panel"><h2>Connect your online shop</h2><p class="muted small">Send orders and abandoned carts from Shopify, WooCommerce or your own site (directly or through Zapier) to the API. Create a key under <a href="#developers">Developers</a>.</p>
      <pre class="code">POST ${h(location.origin)}/api/v1/orders  {"name","phone","items":[{"name","quantity","price"}],"payment":"cod","address","consent":true}
POST ${h(location.origin)}/api/v1/carts   {"name","phone","items":[…],"checkout_url":"https://…","consent":true}
POST ${h(location.origin)}/api/v1/carts/:id/recovered</pre></div>`);
  document.querySelectorAll("form.auto").forEach((f) => {
    f.enabled.onchange = () => (f.querySelector(".switch span").textContent = f.enabled.checked ? "On" : "Off");
    f.onsubmit = async (e) => {
      e.preventDefault();
      const key = f.dataset.key;
      const body = { enabled: f.enabled.checked };
      for (const name of ["messageAfterMinutes", "callAfterMinutes"]) if (f[name]) body[name] = Number(f[name].value);
      if (key === "leadFollowUp") body.steps = [...f.querySelectorAll(".step")].map((r) => ({ afterHours: Number(r.querySelector("[data-hours]").value), channel: r.querySelector("[data-ch]").value }));
      try { await api("PUT", "/automations", { [key]: body }); toast("Saved"); } catch (err) { toast(err.message); }
    };
  });
});

// ---------- Activity & approvals ----------
route("activity", async () => {
  const agentId = new URLSearchParams(location.hash.split("?")[1] || "").get("agent") || "";
  const [log, approvals] = await Promise.all([api("GET", `/activity${agentId ? `?agent=${agentId}` : ""}`), api("GET", "/approvals")]);
  const pending = approvals.filter((a) => a.status === "pending");
  shell("activity", `
    <div class="page-head"><div><h1>Activity & approvals</h1><p class="muted">Every action your AI employees take is recorded here. Anything that needs your judgement waits for you.</p></div></div>
    <div class="panel"><h2>Waiting for your approval ${pending.length ? pill(String(pending.length), "bad") : ""}</h2>
      ${approvals.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>What</th><th>Why</th><th>Status</th><th></th></tr></thead><tbody>
        ${approvals.map((a) => `<tr><td>${fmtDate(a.createdAt)}</td><td>Refund ${rupees(a.amount)}<br><small class="muted">Order ${h(a.ref)} · ${h(a.phone)}</small></td><td class="wrap">${h(a.reason)}</td>
          <td>${pill(a.status, a.status === "approved" ? "" : a.status === "pending" ? "warm" : "grey")}${a.decidedBy ? `<br><small class="muted">by ${h(a.decidedBy)}</small>` : ""}</td>
          <td>${a.status === "pending" ? `<button class="btn small btn-primary" data-ok="${h(a.id)}">Approve</button> <button class="btn small" data-no="${h(a.id)}">Decline</button>` : a.callId ? `<a href="#call/${h(a.callId)}">Conversation</a>` : ""}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">Nothing needs your approval. Refund requests from customers will appear here.</p>`}
    </div>
    <div class="panel"><h2>Activity log ${agentId ? `<a class="btn small" href="#activity">Show everyone</a>` : ""}</h2>
      ${log.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>AI employee</th><th>Action</th><th>Details</th><th>Result</th></tr></thead><tbody>
        ${log.map((x) => `<tr><td>${fmtDate(x.createdAt)}</td><td>${h(x.agentName)}<br><small class="muted">${h(CHANNEL[x.channel] || x.channel || "")}</small></td><td>${pill(x.tool.replace(/_/g, " "), "grey")}</td><td class="wrap small"><code>${h(x.input)}</code></td><td class="wrap small">${h(x.result)}${x.callId ? ` <a href="#call/${h(x.callId)}">View</a>` : ""}</td></tr>`).join("")}
      </tbody></table></div>` : emptyState("No actions yet.")}
    </div>`);
  const decide = (id, d) => async () => {
    const note = prompt(d === "approve" ? "Note for the customer (optional)" : "Message to the customer (optional)", "") ?? "";
    try { await api("POST", `/approvals/${id}/${d}`, { note }); toast(d === "approve" ? "Approved: the customer has been told" : "Declined: the customer has been told"); location.reload(); } catch (err) { toast(err.message); }
  };
  document.querySelectorAll("[data-ok]").forEach((b) => (b.onclick = decide(b.dataset.ok, "approve")));
  document.querySelectorAll("[data-no]").forEach((b) => (b.onclick = decide(b.dataset.no, "decline")));
});

export { state };
