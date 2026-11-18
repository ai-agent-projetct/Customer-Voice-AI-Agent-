// Platform admin console for the VoiceDesk team (emails in ADMIN_EMAILS):
// every business, its usage, and plan changes.
import express from "express";
import { PLANS, usage } from "../plans.js";
import { isAdmin } from "./helpers.js";
import { normalizePhone } from "../util.js";
import { token } from "../voice/router.js";

export function adminRouter(db, auth) {
  const r = express.Router();
  r.use(auth, (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: "Admins only." })));

  r.get("/orgs", (req, res) => {
    const count = (table, orgId) => db.find(table, (x) => x.orgId === orgId).length;
    res.json(
      db.data.orgs
        .map((org) => ({
          id: org.id,
          name: org.name,
          plan: org.plan,
          createdAt: org.createdAt,
          trialEndsAt: org.trialEndsAt,
          owner: db.find("users", (u) => u.orgId === org.id && u.role === "owner")[0]?.email ?? "",
          agents: count("agents", org.id),
          calls: count("calls", org.id),
          bookings: count("appointments", org.id),
          usage: usage(db, org),
        }))
        .reverse(),
    );
  });

  r.put("/orgs/:id", (req, res) => {
    const org = db.get("orgs", req.params.id);
    if (!org) return res.status(404).json({ error: "Business not found." });
    if (!(req.body?.plan in PLANS)) return res.status(400).json({ error: `Plan must be one of ${Object.keys(PLANS).join(", ")}.` });
    res.json(db.update("orgs", org.id, { plan: req.body.plan }));
  });

  // ---------- VoiceDesk Network numbers (DIDs on our own operator trunk) ----------
  r.get("/numbers", (req, res) => res.json(db.find("numbers", (n) => n.carrier === "voicedesk").map((n) => ({ ...n, token: undefined, orgName: db.get("orgs", n.orgId)?.name }))));
  r.post("/numbers", (req, res) => {
    const number = normalizePhone(String(req.body?.number || ""));
    if (!/^\+\d{8,15}$/.test(number)) return res.status(400).json({ error: "Enter the number with country code." });
    if (db.find("numbers", (n) => n.number === number).length) return res.status(400).json({ error: "This number is already assigned." });
    const org = db.get("orgs", req.body?.orgId);
    if (!org) return res.status(400).json({ error: "Business not found." });
    const agent = req.body?.agentId ? db.find("agents", (a) => a.id === req.body.agentId && a.orgId === org.id)[0] : db.find("agents", (a) => a.orgId === org.id)[0];
    const row = db.insert("numbers", { orgId: org.id, number, carrier: "voicedesk", agentId: agent?.id ?? null, label: String(req.body?.label || "VoiceDesk Network"), outbound: true, token: token() });
    res.status(201).json({ ...row, token: undefined });
  });
  r.delete("/numbers/:id", (req, res) => {
    const row = db.get("numbers", req.params.id);
    if (!row || row.carrier !== "voicedesk") return res.status(404).json({ error: "Number not found." });
    res.json({ ok: db.remove("numbers", row.id) });
  });

  return r;
}
