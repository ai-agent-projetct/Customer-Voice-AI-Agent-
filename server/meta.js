// Instagram DM and Facebook Messenger through Meta's Messenger Platform.
//
// Setup (Meta developer app with the Messenger and Instagram products):
//   Callback URL:   https://YOUR-DOMAIN/meta/webhook
//   Verify token:   the value of META_VERIFY_TOKEN
//   Subscribe to:   messages
//   App secret:     META_APP_SECRET (we check X-Hub-Signature-256 on every delivery)
//   Page token:     paste into Settings → Channels (or META_PAGE_TOKEN)
// Then put the Facebook Page ID / Instagram account ID on the AI employee.
// Meta only allows free-form replies within 24 hours of the customer's last message.
import crypto from "node:crypto";
import express from "express";

export const metaTransport = {
  async send({ channel, pageId, recipientId, text, token }) {
    const access = token || process.env.META_PAGE_TOKEN;
    if (!access || !pageId) return { delivered: "not_configured" };
    const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
      body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: "RESPONSE", message: { text: text.slice(0, 1000) } }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { delivered: "sent", id: data.message_id } : { delivered: "failed", error: data.error?.message || `HTTP ${res.status}` };
  },
};

export function metaSignature(secret, rawBody) {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

const inFlight = new Set();
/** Resolves when every message received so far has been answered (used by tests). */
export function metaIdle() {
  return Promise.all([...inFlight]);
}

export function metaRouter(db, handleIncoming) {
  const r = express.Router();

  // Meta's one-time check that the URL belongs to us.
  r.get("/webhook", (req, res) => {
    const ok = req.query["hub.mode"] === "subscribe" && process.env.META_VERIFY_TOKEN && req.query["hub.verify_token"] === process.env.META_VERIFY_TOKEN;
    return ok ? res.type("text/plain").send(String(req.query["hub.challenge"] ?? "")) : res.sendStatus(403);
  });

  r.post("/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    const raw = req.body instanceof Buffer ? req.body : Buffer.from("");
    const secret = process.env.META_APP_SECRET;
    if (secret) {
      const expected = metaSignature(secret, raw);
      const given = req.get("x-hub-signature-256") || "";
      if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return res.sendStatus(403);
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.sendStatus(400);
    }
    res.sendStatus(200); // Meta wants a fast acknowledgement; replies are sent separately

    const channel = payload.object === "instagram" ? "instagram" : payload.object === "page" ? "messenger" : null;
    if (!channel) return;
    for (const entry of payload.entry || []) {
      for (const event of entry.messaging || []) {
        const text = event.message?.text;
        if (!text || event.message?.is_echo) continue; // ignore our own replies and attachments
        const accountId = String(event.recipient?.id || entry.id);
        const agent = db.find("agents", (a) => a.active && (channel === "instagram" ? a.instagramId : a.messengerPageId) === accountId)[0];
        if (!agent) continue;
        const job = (async () => {
          const { reply } = await handleIncoming(db, { agent, channel, from: String(event.sender.id), text: text.slice(0, 2000) });
          if (reply) {
            const org = db.get("orgs", agent.orgId);
            await metaTransport.send({ channel, pageId: accountId, recipientId: event.sender.id, text: reply, token: org?.metaPageToken });
          }
        })().catch((err) => console.error("Meta message failed", err)).finally(() => inFlight.delete(job));
        inFlight.add(job);
      }
    }
  });
  return r;
}
