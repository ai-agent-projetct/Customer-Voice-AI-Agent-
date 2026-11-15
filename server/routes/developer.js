// Developer settings in the dashboard: API keys, webhooks and their delivery log.
import crypto from "node:crypto";
import express from "express";
import { EVENTS, emitEvent, webhookUrlProblem } from "../webhooks.js";
import { owned } from "./helpers.js";

export const hashKey = (key) => crypto.createHash("sha256").update(key).digest("hex");

export function developerRouter(db, auth) {
  const r = express.Router();
  r.use(auth);
  const mine = (table, req) => db.find(table, (x) => x.orgId === req.org.id);

  // API keys: shown once when created; only a hash is stored.
  r.get("/api-keys", (req, res) => res.json(mine("apiKeys", req).map(({ hash, ...k }) => k)));
  r.post("/api-keys", (req, res) => {
    if (mine("apiKeys", req).length >= 10) return res.status(400).json({ error: "At most 10 API keys." });
    const key = `vd_live_${crypto.randomBytes(24).toString("base64url")}`;
    const row = db.insert("apiKeys", { orgId: req.org.id, name: String(req.body?.name || "API key").slice(0, 60), prefix: key.slice(0, 12), hash: hashKey(key), lastUsedAt: null });
    const { hash, ...safe } = row;
    res.status(201).json({ ...safe, key });
  });
  r.delete("/api-keys/:id", (req, res) => {
    const row = owned(db, "apiKeys", req, res);
    if (row) res.json({ ok: db.remove("apiKeys", row.id) });
  });

  // Webhooks.
  r.get("/webhooks", (req, res) => res.json({ events: EVENTS, webhooks: mine("webhooks", req) }));
  r.post("/webhooks", (req, res) => {
    const problem = webhookUrlProblem(req.body?.url);
    if (problem) return res.status(400).json({ error: problem });
    const events = (Array.isArray(req.body?.events) ? req.body.events : EVENTS).filter((e) => EVENTS.includes(e));
    if (!events.length) return res.status(400).json({ error: "Choose at least one event." });
    if (mine("webhooks", req).length >= 10) return res.status(400).json({ error: "At most 10 webhooks." });
    res.status(201).json(db.insert("webhooks", { orgId: req.org.id, url: String(req.body.url), events, active: true, secret: `whsec_${crypto.randomBytes(24).toString("base64url")}` }));
  });
  r.delete("/webhooks/:id", (req, res) => {
    const row = owned(db, "webhooks", req, res);
    if (row) res.json({ ok: db.remove("webhooks", row.id) });
  });
  r.post("/webhooks/:id/test", (req, res) => {
    const row = owned(db, "webhooks", req, res);
    if (!row) return;
    const delivery = db.insert("deliveries", { orgId: req.org.id, webhookId: row.id, type: "test.ping", status: "pending", attempts: 0, body: JSON.stringify({ type: "test.ping", created_at: new Date().toISOString(), data: { message: "Hello from VoiceDesk" } }) });
    import("../webhooks.js").then(({ deliver }) => deliver(db, delivery)).then((d) => res.json(d));
  });
  r.get("/deliveries", (req, res) => res.json(mine("deliveries", req).reverse().slice(0, 50).map(({ body, ...d }) => ({ ...d, preview: body.slice(0, 300) }))));

  return r;
}
export { emitEvent };
