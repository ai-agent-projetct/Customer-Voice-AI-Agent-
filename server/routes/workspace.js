// Dashboard API for the AI workforce: Inbox (human takeover), Company Brain,
// Activity log, Approvals, Automations, the team overview and channel settings.
import express from "express";
import { AUTOMATION_DEFAULTS, automationsOf } from "../automations.js";
import { askBrain, searchBrain } from "../brain.js";
import { CHAT_CHANNELS, closeConversation, sendHumanReply } from "../channels.js";
import { queueMessage } from "../messaging.js";
import { PERMISSIONS, ROLES } from "../tools.js";
import { owned, wrap } from "./helpers.js";

export function workspaceRouter(db, auth) {
  const r = express.Router();
  r.use(auth);
  const mine = (table, req, extra = () => true) => db.find(table, (x) => x.orgId === req.org.id && extra(x));
  const lastAt = (c) => c.transcript.at(-1)?.at ?? c.createdAt;
  const lastCustomerAt = (c) => [...c.transcript].reverse().find((t) => t.role === "caller")?.at ?? null;

  // ---------- Inbox ----------
  r.get("/inbox", (req, res) => {
    const filter = req.query.filter || "open";
    const rows = mine("calls", req, (c) => CHAT_CHANNELS.includes(c.channel) && (filter === "all" || (filter === "human" ? c.humanMode && c.status === "live" : c.status === "live")))
      .sort((a, b) => (lastAt(a) < lastAt(b) ? 1 : -1))
      .slice(0, 200)
      .map((c) => ({
        id: c.id, channel: c.channel, status: c.status, humanMode: Boolean(c.humanMode), agentName: c.agentName,
        customer: c.customerName || (c.customerId && db.get("customers", c.customerId)?.name) || c.callerNumber || "Website visitor",
        lastLine: c.transcript.at(-1)?.text ?? "", lastAt: lastAt(c),
        unread: Boolean(lastCustomerAt(c) && (!c.ownerSeenAt || c.ownerSeenAt < lastCustomerAt(c))),
        needsPerson: Boolean(c.humanMode && c.humanRequestedAt && !c.lastHumanReplyAt),
      }));
    res.json(rows);
  });

  const conversation = (req, res) => {
    const call = owned(db, "calls", req, res, "Conversation not found.");
    if (call && !CHAT_CHANNELS.includes(call.channel)) {
      res.status(400).json({ error: "Not a chat conversation." });
      return null;
    }
    return call;
  };

  r.get("/inbox/:id", (req, res) => {
    const call = conversation(req, res);
    if (!call) return;
    db.update("calls", call.id, { ownerSeenAt: new Date().toISOString() });
    const { messages, system, widgetSecretHash, relayToken, ...rest } = call;
    const customer = call.customerId ? db.get("customers", call.customerId) : null;
    res.json({ ...rest, customer, orders: customer?.phone ? mine("orders", req, (o) => o.phone === customer.phone).slice(-5) : [] });
  });

  r.post("/inbox/:id/takeover", (req, res) => {
    const call = conversation(req, res);
    if (call) res.json(db.update("calls", call.id, { humanMode: true, takenOverBy: req.user.name, takenOverAt: new Date().toISOString() }));
  });
  r.post("/inbox/:id/release", (req, res) => {
    const call = conversation(req, res);
    if (call) res.json(db.update("calls", call.id, { humanMode: false, humanRequestedAt: null }));
  });
  r.post("/inbox/:id/reply", wrap(async (req, res) => {
    const call = conversation(req, res);
    if (!call) return;
    if (call.status === "ended") return res.status(409).json({ error: "This conversation has ended." });
    const text = String(req.body?.text || "").trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: "Write a message first." });
    const out = await sendHumanReply(db, call, text, req.user.name.split(" ")[0]);
    res.json({ ok: true, ...out });
  }));
  r.post("/inbox/:id/close", (req, res) => {
    const call = conversation(req, res);
    if (!call) return;
    closeConversation(db, call);
    res.json({ ok: true });
  });

  // ---------- Company Brain ----------
  r.get("/brain", (req, res) => {
    res.json(mine("knowledge", req).reverse().map(({ content, ...d }) => ({ ...d, words: content.split(/\s+/).length, preview: content.slice(0, 200) })));
  });
  r.get("/brain/:id", (req, res) => {
    const doc = owned(db, "knowledge", req, res, "Document not found.");
    if (doc) res.json(doc);
  });
  r.post("/brain", (req, res) => {
    const title = String(req.body?.title || "").trim().slice(0, 120);
    const content = String(req.body?.content || "").trim();
    const visibility = req.body?.visibility === "public" ? "public" : "internal";
    if (!title || !content) return res.status(400).json({ error: "Give the document a title and some text." });
    if (content.length > 200_000) return res.status(400).json({ error: "That document is too long (200,000 characters max). Split it into parts." });
    if (mine("knowledge", req).length >= 500) return res.status(400).json({ error: "At most 500 documents." });
    res.status(201).json(db.insert("knowledge", { orgId: req.org.id, title, content, visibility, source: String(req.body?.source || "note").slice(0, 20), addedBy: req.user.name }));
  });
  r.put("/brain/:id", (req, res) => {
    const doc = owned(db, "knowledge", req, res, "Document not found.");
    if (!doc) return;
    const changes = {};
    if (req.body?.title) changes.title = String(req.body.title).trim().slice(0, 120);
    if (req.body?.content) changes.content = String(req.body.content).trim().slice(0, 200_000);
    if (req.body?.visibility) changes.visibility = req.body.visibility === "public" ? "public" : "internal";
    res.json(db.update("knowledge", doc.id, changes));
  });
  r.delete("/brain/:id", (req, res) => {
    const doc = owned(db, "knowledge", req, res, "Document not found.");
    if (doc) res.json({ ok: db.remove("knowledge", doc.id) });
  });
  r.post("/brain/ask", wrap(async (req, res) => {
    const q = String(req.body?.question || "").trim().slice(0, 500);
    if (!q) return res.status(400).json({ error: "Ask a question." });
    res.json(await askBrain(db, req.org.id, q));
  }));
  r.get("/brain-search", (req, res) => res.json(searchBrain(db, req.org.id, String(req.query.q || ""), { includeInternal: true, includeCalls: true, limit: 10 })));

  // ---------- Activity log & approvals (guardrails) ----------
  r.get("/activity", (req, res) => {
    const agentId = req.query.agent;
    res.json(mine("activity", req, (a) => !agentId || a.agentId === agentId).reverse().slice(0, 300));
  });
  r.get("/approvals", (req, res) => res.json(mine("approvals", req).reverse().slice(0, 200)));
  r.post("/approvals/:id/:decision", (req, res, next) => {
    if (!["approve", "decline"].includes(req.params.decision)) return next();
    const row = owned(db, "approvals", req, res, "Request not found.");
    if (!row) return;
    if (row.status !== "pending") return res.status(409).json({ error: "Already decided." });
    const approved = req.params.decision === "approve";
    const updated = db.update("approvals", row.id, { status: approved ? "approved" : "declined", decidedBy: req.user.name, decidedAt: new Date().toISOString(), note: String(req.body?.note || "").slice(0, 300) });
    const order = row.orderId && db.get("orders", row.orderId);
    if (approved && order) db.update("orders", order.id, { status: "refund_approved", refund: row.amount });
    // Tell the customer the decision on WhatsApp/SMS.
    queueMessage(db, {
      orgId: req.org.id, to: row.phone, kind: approved ? "refund_approved" : "refund_declined",
      body: approved
        ? `${req.org.name}: your refund of ₹${row.amount} for order ${row.ref} is approved.${updated.note ? ` ${updated.note}` : ""}`
        : `${req.org.name}: about your refund request for order ${row.ref}: ${updated.note || "our team will call you to discuss it."}`,
    });
    res.json(updated);
  });

  // ---------- AI workforce overview ----------
  r.get("/team", (req, res) => {
    const since = new Date(Date.now() - 864e5).toISOString();
    res.json({
      roles: ROLES,
      permissions: Object.fromEntries(Object.entries(PERMISSIONS).map(([k, v]) => [k, v.label])),
      agents: mine("agents", req).map((a) => {
        const today = mine("calls", req, (c) => c.agentId === a.id && c.createdAt >= since && c.channel !== "simulation");
        const actions = mine("activity", req, (x) => x.agentId === a.id && x.createdAt >= since);
        return {
          id: a.id, name: a.name, role: a.role || "receptionist", active: a.active,
          channels: [a.phoneNumber && "phone", a.whatsappEnabled && "whatsapp", a.instagramId && "instagram", a.messengerPageId && "messenger", a.widgetEnabled && "widget"].filter(Boolean),
          conversationsToday: today.length, live: today.filter((c) => c.status === "live").length,
          actionsToday: actions.length, lastAction: actions.at(-1) ?? null,
        };
      }),
    });
  });

  // ---------- Automations ----------
  r.get("/automations", (req, res) => {
    const auto = automationsOf(req.org);
    res.json({
      settings: auto,
      waiting: {
        codOrders: mine("orders", req, (o) => o.status === "awaiting_confirmation").length,
        carts: mine("carts", req, (c) => c.status === "abandoned").length,
        leads: mine("leads", req, (l) => l.status === "new" && (l.followUpStep || 0) < auto.leadFollowUp.steps.length).length,
      },
    });
  });
  r.put("/automations", (req, res) => {
    const b = req.body ?? {};
    const next = automationsOf(req.org);
    const minutes = (v, d) => Math.min(10080, Math.max(1, Math.round(Number(v)) || d));
    for (const key of Object.keys(AUTOMATION_DEFAULTS)) {
      if (!b[key]) continue;
      if ("enabled" in b[key]) next[key].enabled = Boolean(b[key].enabled);
      for (const f of ["messageAfterMinutes", "callAfterMinutes"]) if (f in b[key] && f in next[key]) next[key][f] = minutes(b[key][f], next[key][f]);
    }
    if (Array.isArray(b.leadFollowUp?.steps)) {
      const steps = b.leadFollowUp.steps.slice(0, 6).map((s) => ({ afterHours: Math.min(720, Math.max(0, Number(s.afterHours) || 0)), channel: s.channel === "call" ? "call" : "whatsapp" }));
      if (!steps.length) return res.status(400).json({ error: "Add at least one follow-up step." });
      next.leadFollowUp.steps = steps.sort((a, b2) => a.afterHours - b2.afterHours);
    }
    res.json(db.update("orgs", req.org.id, { automations: next }).automations);
  });
  r.get("/carts", (req, res) => res.json(mine("carts", req).reverse().slice(0, 200)));

  // ---------- Channel settings ----------
  r.get("/channels", (req, res) => {
    res.json({
      metaConnected: Boolean(req.org.metaPageToken || process.env.META_PAGE_TOKEN),
      metaTokenLast4: req.org.metaPageToken ? req.org.metaPageToken.slice(-4) : null,
      webhookUrl: "/meta/webhook",
      verifyTokenSet: Boolean(process.env.META_VERIFY_TOKEN),
      appSecretSet: Boolean(process.env.META_APP_SECRET),
    });
  });
  r.put("/channels", (req, res) => {
    const token = String(req.body?.metaPageToken ?? "").trim();
    if (token && !/^[A-Za-z0-9_-]{20,600}$/.test(token)) return res.status(400).json({ error: "That doesn't look like a Meta page access token." });
    db.update("orgs", req.org.id, { metaPageToken: token });
    res.json({ ok: true, metaConnected: Boolean(token) });
  });

  return r;
}
