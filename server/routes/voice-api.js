// VoiceDesk Voice API (/api/v1/voice): programmable calls on VoiceDesk
// Network, for developers, the same idea as Twilio's or Plivo's voice APIs.
//
//   POST   /voice/calls                 place a call that runs a flow (or asks your answer_url)
//   GET    /voice/calls/:id             status, talk time, billed minutes, cost, recording, flow events
//   POST   /voice/calls/:id/hangup      end a call
//   GET    /voice/recordings/:id        the recording as WAV
//   GET    /voice/numbers               your VoiceDesk Network numbers
//   PATCH  /voice/numbers/:id           send incoming calls to your voice_url instead of the AI
//   GET    /voice/usage                 minutes and cost this month
import express from "express";
import { normalizePhone } from "../util.js";
import { dialFlow, hangupCall, sipHooks } from "../sip/gateway.js";
import { flowProblem } from "../sip/flow.js";
import { publicVoiceCall, rates, recordingFile, urlProblem } from "../sip/records.js";

export function voiceApiRouter(db) {
  const r = express.Router();
  const own = (table, req, res) => {
    const row = db.get(table, req.params.id);
    if (!row || row.orgId !== req.org.id) {
      res.status(404).json({ error: "Not found." });
      return null;
    }
    return row;
  };
  const myNumbers = (req) => db.find("numbers", (n) => n.orgId === req.org.id && n.carrier === "voicedesk");
  const numberView = (n) => ({ id: n.id, number: n.number, voice_url: n.voiceUrl || null, status_callback: n.statusCallback || null, record: Boolean(n.record), handled_by: n.voiceUrl ? "your voice_url" : "AI receptionist" });

  r.post("/calls", (req, res) => {
    const b = req.body || {};
    if (!sipHooks.canDial) return res.status(503).json({ error: "VoiceDesk Network can't place calls right now (no operator trunk)." });
    const to = normalizePhone(String(b.to || ""));
    if (!/^\+\d{8,15}$/.test(to)) return res.status(400).json({ error: "to: a phone number with country code, e.g. +919811000001." });
    const numbers = myNumbers(req);
    const number = b.from ? numbers.find((n) => n.number === normalizePhone(String(b.from))) : numbers[0];
    if (!number) return res.status(400).json({ error: b.from ? "from: not one of your VoiceDesk Network numbers." : "You don't have a VoiceDesk Network number yet." });
    if (!b.flow && !b.answer_url) return res.status(400).json({ error: "Send a flow (list of steps) or an answer_url that returns one." });
    if (b.flow) {
      const problem = flowProblem(b.flow);
      if (problem) return res.status(400).json({ error: `flow: ${problem}` });
    }
    for (const key of ["answer_url", "status_callback"]) {
      if (b[key]) {
        const problem = urlProblem(String(b[key]));
        if (problem) return res.status(400).json({ error: `${key}: ${problem}` });
      }
    }
    if (db.find("customers", (c) => c.orgId === req.org.id && c.phone === to && c.doNotCall).length) {
      return res.status(400).json({ error: "This number is on your do-not-call list." });
    }
    const call = dialFlow(db, { number, to, flow: b.flow, answerUrl: b.answer_url, statusCallback: b.status_callback, record: Boolean(b.record) });
    res.status(201).json(publicVoiceCall(db, call));
  });

  r.get("/calls/:id", (req, res) => {
    const call = own("calls", req, res);
    if (call) res.json(publicVoiceCall(db, call));
  });

  r.post("/calls/:id/hangup", async (req, res) => {
    const call = own("calls", req, res);
    if (!call) return;
    await hangupCall(db, call.id);
    res.json(publicVoiceCall(db, db.get("calls", call.id)));
  });

  r.get("/recordings/:id", (req, res) => {
    const row = own("recordings", req, res);
    if (!row) return;
    const file = recordingFile(row);
    if (!file) return res.status(404).json({ error: "Recording file not found." });
    res.type("audio/wav").sendFile(file);
  });

  r.get("/numbers", (req, res) => res.json({ data: myNumbers(req).map(numberView) }));

  r.patch("/numbers/:id", (req, res) => {
    const row = own("numbers", req, res);
    if (!row) return;
    if (row.carrier !== "voicedesk") return res.status(400).json({ error: "Only VoiceDesk Network numbers can be programmed." });
    const b = req.body || {};
    const changes = {};
    for (const [key, field] of [["voice_url", "voiceUrl"], ["status_callback", "statusCallback"]]) {
      if (!(key in b)) continue;
      if (b[key]) {
        const problem = urlProblem(String(b[key]));
        if (problem) return res.status(400).json({ error: `${key}: ${problem}` });
      }
      changes[field] = b[key] ? String(b[key]) : null;
    }
    if ("record" in b) changes.record = Boolean(b.record);
    res.json(numberView(db.update("numbers", row.id, changes)));
  });

  r.get("/usage", (req, res) => {
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    const calls = db.find("calls", (c) => c.orgId === req.org.id && c.carrier === "voicedesk" && c.status === "ended" && String(c.createdAt).startsWith(month));
    const sum = (dir, key) => calls.filter((c) => (c.direction || "inbound") === dir).reduce((n, c) => n + (c[key] || 0), 0);
    res.json({
      month,
      rates_inr_per_minute: { inbound: rates().inbound / 100, outbound: rates().outbound / 100 },
      inbound: { calls: calls.filter((c) => (c.direction || "inbound") === "inbound").length, minutes: sum("inbound", "billedMinutes"), cost_inr: sum("inbound", "costPaise") / 100 },
      outbound: { calls: calls.filter((c) => c.direction === "outbound").length, minutes: sum("outbound", "billedMinutes"), cost_inr: sum("outbound", "costPaise") / 100 },
    });
  });

  return r;
}
