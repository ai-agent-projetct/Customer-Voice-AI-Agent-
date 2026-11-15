// Quality, Orders, Scheduled calls and Developers (API keys + webhooks).
import { api, bindRowLinks, emptyState, fmtDate, h, pill, route, rupees, shell, toast } from "../core.js";
import { callsTable } from "./records.js";

// ---------- quality ----------
route("quality", async () => {
  const q = await api("GET", "/quality");
  const bar = (label, v) => `<div class="qrow"><span>${label}</span><div class="meter"><span style="width:${(v / 5) * 100}%"></span></div><b>${v}/5</b></div>`;
  shell("quality", `
    <div class="page-head"><div><h1>Quality</h1><p class="muted">Every call is audited automatically: accuracy, helpfulness, empathy and whether the caller's need was resolved.</p></div></div>
    ${q.calls ? `
    <div class="grid-2">
      <div class="panel"><div class="score"><div class="ring" style="--p:${q.score}"><b>${q.score}</b></div><div><h2>Average quality score</h2><p class="muted">Across ${q.calls} audited call${q.calls === 1 ? "" : "s"}.</p></div></div>
        ${bar("Accuracy", q.accuracy)}${bar("Helpfulness", q.helpfulness)}${bar("Empathy", q.empathy)}${bar("Resolution", q.resolution)}</div>
      <div class="panel"><h2>Most common problems</h2>${q.topIssues.length ? `<ul class="taught">${q.topIssues.map((i) => `<li>${pill(`${i.count}×`, "warm")} ${h(i.issue)}</li>`).join("")}</ul>` : `<p class="muted">No problems found. 🎉</p>`}</div>
    </div>
    <div class="panel"><h2>Calls to review first</h2>${callsTable(q.lowest)}</div>` : `<div class="panel">${emptyState("Quality scores appear after your first calls.")}</div>`}`);
  bindRowLinks();
});

// ---------- orders ----------
route("orders", async () => {
  const rows = await api("GET", "/orders");
  const statuses = ["new", "preparing", "ready", "completed", "cancelled"];
  shell("orders", `
    <div class="page-head"><div><h1>Orders</h1><p class="muted">Orders your receptionist took by phone. Turn this on under Receptionists → Phone & website.</p></div></div>
    <div class="panel">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Ref</th><th>Customer</th><th>Items</th><th>Total</th><th>Pickup / delivery</th><th>Status</th></tr></thead><tbody>
      ${rows.map((o) => `<tr><td>${fmtDate(o.createdAt)}</td><td>${h(o.ref)}</td><td>${h(o.customerName)}<br><small class="muted">${h(o.phone)}</small></td><td class="wrap">${o.items.map((i) => `${i.quantity} × ${h(i.name)}`).join(", ")}${o.notes ? `<br><small class="muted">${h(o.notes)}</small>` : ""}</td><td>${rupees(o.total)}</td><td>${h(o.fulfilment)}${o.address ? `<br><small class="muted">${h(o.address)}</small>` : ""}</td>
        <td><select data-id="${h(o.id)}" aria-label="Status">${statuses.map((s) => `<option ${s === o.status ? "selected" : ""}>${s}</option>`).join("")}</select></td></tr>`).join("")}
    </tbody></table></div>` : emptyState("No orders yet.")}</div>`);
  document.querySelectorAll("select[data-id]").forEach((sel) => (sel.onchange = async () => { await api("PATCH", `/orders/${sel.dataset.id}`, { status: sel.value }); toast("Updated"); }));
});

// ---------- scheduled calls ----------
route("scheduled", async () => {
  const rows = await api("GET", "/callbacks");
  const SOURCE = { phone: "Caller asked", web: "Test call", widget: "Website chat", whatsapp: "WhatsApp", lead: "New lead (speed to lead)", api: "API" };
  const TONE = { pending: "warm", calling: "live", done: "", failed: "bad", skipped: "grey", cancelled: "grey" };
  shell("scheduled", `
    <div class="page-head"><div><h1>Scheduled calls</h1><p class="muted">Callbacks customers asked for, and calls to new leads. Calls are only placed between 9am and 9pm, never to do-not-call numbers.</p></div></div>
    <div class="panel">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>About</th><th>Why</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((c) => `<tr><td>${c.date ? `${h(c.date)} ${h(c.time)}` : "As soon as possible"}</td><td>${h(c.name || "")} ${h(c.phone)}</td><td class="wrap">${h(c.reason)}</td><td>${h(SOURCE[c.source] || c.source)}</td>
        <td>${pill(c.status, TONE[c.status] ?? "grey")}${c.error ? `<br><small class="muted">${h(c.error)}</small>` : ""}</td>
        <td>${c.status === "pending" ? `<button class="btn small" data-cancel="${h(c.id)}">Cancel</button>` : c.callId ? `<a href="#call/${h(c.callId)}">View call</a>` : ""}</td></tr>`).join("")}
    </tbody></table></div>` : emptyState("Nothing scheduled. When a caller says “call me back at 5”, it appears here.")}</div>`);
  document.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => { await api("DELETE", `/callbacks/${b.dataset.cancel}`); location.reload(); }));
});

// ---------- developers ----------
route("developers", async () => {
  const [keys, hooks, deliveries] = await Promise.all([api("GET", "/developer/api-keys"), api("GET", "/developer/webhooks"), api("GET", "/developer/deliveries")]);
  const base = location.origin;
  shell("developers", `
    <div class="page-head"><div><h1>Developers</h1><p class="muted">Connect VoiceDesk to your CRM, website forms, Zapier or your own software.</p></div></div>
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><h2>API keys</h2><button class="btn small btn-primary" id="new-key">Create key</button></div>
        <div id="key-out"></div>
        ${keys.length ? `<ul class="taught">${keys.map((k) => `<li><b>${h(k.name)}</b> <code>${h(k.prefix)}…</code><br><small class="muted">Created ${fmtDate(k.createdAt)} · last used ${k.lastUsedAt ? fmtDate(k.lastUsedAt) : "never"}</small> <button class="btn small btn-danger" data-del-key="${h(k.id)}">Delete</button></li>`).join("")}</ul>` : `<p class="muted">No keys yet.</p>`}
      </div>
      <div class="panel"><h2>Speed to lead</h2>
        <p class="muted small">Send new leads from your website form or ads. With <code>call_now</code>, the receptionist phones them within seconds (9am–9pm).</p>
        <pre class="code">curl -X POST ${h(base)}/api/v1/leads \\
  -H "Authorization: Bearer vd_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Neha","phone":"+919811200003",
       "interest":"Bridal package",
       "call_now":true,"consent":true}'</pre>
        <p class="muted small">Also: <code>GET /api/v1/calls</code>, <code>GET /api/v1/calls/:id</code>, <code>POST /api/v1/calls</code>, <code>GET /api/v1/leads</code>, <code>GET /api/v1/appointments</code>.</p>
      </div>
    </div>
    <div class="panel"><h2>Webhooks</h2>
      <p class="muted small">We POST a signed JSON message to your URL when these happen. Verify <code>X-VoiceDesk-Signature</code> = <code>sha256=HMAC(secret, timestamp + "." + body)</code>.</p>
      <form id="hook" class="row-between" style="align-items:flex-end;gap:10px">
        <label style="flex:1;margin:0">URL<input name="url" required placeholder="https://your-crm.example.com/voicedesk"></label>
        <button class="btn btn-primary">Add webhook</button>
      </form>
      <div class="chips" style="margin:10px 0">${hooks.events.map((e) => `<label class="check small"><input type="checkbox" name="ev" value="${e}" checked form="hook"> ${e}</label>`).join("")}</div>
      <p class="error" id="hook-err" role="alert"></p>
      ${hooks.webhooks.length ? `<div class="table-wrap"><table><thead><tr><th>URL</th><th>Events</th><th>Signing secret</th><th></th></tr></thead><tbody>
        ${hooks.webhooks.map((w) => `<tr><td class="wrap">${h(w.url)}</td><td class="wrap">${w.events.map((e) => pill(e, "grey")).join(" ")}</td><td><code>${h(w.secret)}</code></td><td><button class="btn small" data-test="${h(w.id)}">Send test</button> <button class="btn small btn-danger" data-del-hook="${h(w.id)}">Delete</button></td></tr>`).join("")}
      </tbody></table></div>` : ""}
    </div>
    <div class="panel"><h2>Recent deliveries</h2>${deliveries.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Event</th><th>Status</th><th>Attempts</th></tr></thead><tbody>
      ${deliveries.map((d) => `<tr><td>${fmtDate(d.createdAt)}</td><td>${h(d.type)}</td><td>${pill(d.status, d.status === "delivered" ? "" : d.status === "failed" ? "bad" : "warm")}${d.error ? ` <small class="muted">${h(d.error)}</small>` : ""}</td><td>${d.attempts}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="muted">Nothing sent yet.</p>`}</div>`);

  document.getElementById("new-key").onclick = async () => {
    const name = prompt("Name for this key (e.g. Website form)", "My integration");
    if (name === null) return;
    const k = await api("POST", "/developer/api-keys", { name });
    document.getElementById("key-out").innerHTML = `<div class="banner ok"><b>Copy this key now. It won't be shown again.</b><br><code>${h(k.key)}</code></div>`;
  };
  document.querySelectorAll("[data-del-key]").forEach((b) => (b.onclick = async () => { if (confirm("Delete this key? Anything using it stops working.")) { await api("DELETE", `/developer/api-keys/${b.dataset.delKey}`); location.reload(); } }));
  document.querySelectorAll("[data-del-hook]").forEach((b) => (b.onclick = async () => { await api("DELETE", `/developer/webhooks/${b.dataset.delHook}`); location.reload(); }));
  document.querySelectorAll("[data-test]").forEach((b) => (b.onclick = async () => { const d = await api("POST", `/developer/webhooks/${b.dataset.test}/test`); toast(d.status === "delivered" ? "Test delivered" : `Test failed: ${d.error}`); }));
  document.getElementById("hook").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("POST", "/developer/webhooks", { url: e.target.url.value.trim(), events: [...document.querySelectorAll("[name=ev]:checked")].map((c) => c.value) });
      location.reload();
    } catch (err) {
      document.getElementById("hook-err").textContent = err.message;
    }
  };
});
