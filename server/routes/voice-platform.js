// Dashboard side of the Voice API (signed-in owners, not API keys): network
// numbers and where their calls go, a flow tester that rings the owner's
// phone, recent programmable calls, recordings and this month's bill.
import express from "express";
import { normalizePhone } from "../util.js";
import { dialFlow, sipHooks } from "../sip/gateway.js";
import { flowProblem } from "../sip/flow.js";
import { publicVoiceCall, rates, recordingFile, urlProblem } from "../sip/records.js";
import { owned } from "./helpers.js";

export function voicePlatformRouter(db, auth) {
  const r = express.Router();
  r.use(auth);
  const numbers = (req) => db.find("numbers", (n) => n.orgId === req.org.id && n.carrier === "voicedesk");

  r.get("/voice-platform", (req, res) => {
    const month = new Date().toISOString().slice(0, 7);
    const calls = db.find("calls", (c) => c.orgId === req.org.id && c.carrier === "voicedesk");
    const monthCalls = calls.filter((c) => c.status === "ended" && String(c.createdAt).startsWith(month));
    const total = (key, dir) => monthCalls.filter((c) => !dir || (c.direction || "inbound") === dir).reduce((n, c) => n + (c[key] || 0), 0);
    res.json({
      network: { enabled: Boolean(sipHooks.enabled), canDial: Boolean(sipHooks.canDial) },
      ownerPhone: req.org.ownerPhone || null,
      numbers: numbers(req).map((n) => ({ id: n.id, number: n.number, label: n.label || "", voiceUrl: n.voiceUrl || "", statusCallback: n.statusCallback || "", record: Boolean(n.record) })),
      usage: {
        month,
        rates: { inbound: rates().inbound / 100, outbound: rates().outbound / 100 },
        calls: monthCalls.length,
        inboundMinutes: total("billedMinutes", "inbound"),
        outboundMinutes: total("billedMinutes", "outbound"),
        costInr: total("costPaise") / 100,
      },
      calls: calls.slice(-25).reverse().map((c) => publicVoiceCall(db, c)),
      recordings: db.find("recordings", (x) => x.orgId === req.org.id).slice(-25).reverse()
        .map((x) => ({ id: x.id, callId: x.callId, kind: x.kind, seconds: x.durationSec, createdAt: x.createdAt })),
    });
  });

  r.patch("/voice-platform/numbers/:id", (req, res) => {
    const row = owned(db, "numbers", req, res, "Number not found.");
    if (!row) return;
    if (row.carrier !== "voicedesk") return res.status(400).json({ error: "Only VoiceDesk Network numbers can be programmed." });
    const changes = {};
    for (const key of ["voiceUrl", "statusCallback"]) {
      if (!(key in req.body)) continue;
      const value = String(req.body[key] || "").trim();
      if (value) {
        const problem = urlProblem(value);
        if (problem) return res.status(400).json({ error: problem });
      }
      changes[key] = value || null;
    }
    if ("record" in req.body) changes.record = Boolean(req.body.record);
    db.update("numbers", row.id, changes);
    res.json({ ok: true });
  });

  r.post("/voice-platform/validate", (req, res) => {
    const problem = flowProblem(req.body?.flow);
    res.json({ ok: !problem, problem });
  });

  // Try a flow on your own phone.
  r.post("/voice-platform/test-flow", (req, res) => {
    const flow = req.body?.flow;
    const problem = flowProblem(flow);
    if (problem) return res.status(400).json({ error: problem });
    if (!sipHooks.canDial) return res.status(503).json({ error: "VoiceDesk Network can't place calls yet: connect an operator SIP trunk (docs/TELEPHONY-PLATFORM.md)." });
    const number = numbers(req)[0];
    if (!number) return res.status(400).json({ error: "You need a VoiceDesk Network number first (the VoiceDesk team gives these out)." });
    const to = normalizePhone(req.org.ownerPhone || "");
    if (!/^\+\d{8,15}$/.test(to)) return res.status(400).json({ error: "Add your mobile number in Settings: test calls ring your own phone." });
    const call = dialFlow(db, { number, to, flow, record: Boolean(req.body?.record) });
    res.status(201).json(publicVoiceCall(db, call));
  });

  r.get("/voice-platform/calls/:id", (req, res) => {
    const call = owned(db, "calls", req, res, "Call not found.");
    if (call) res.json(publicVoiceCall(db, call));
  });

  r.get("/voice-platform/recordings/:id", (req, res) => {
    const row = owned(db, "recordings", req, res, "Recording not found.");
    if (!row) return;
    const file = recordingFile(row);
    if (!file) return res.status(404).json({ error: "Recording file not found." });
    res.type("audio/wav").sendFile(file);
  });

  return r;
}
