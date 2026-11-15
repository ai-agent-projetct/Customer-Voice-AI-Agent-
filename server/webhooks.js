// Outgoing webhooks: tell the business's other systems (CRM, Zapier, Google
// Sheets, their own app) when something happens. Each delivery is signed so
// the receiver can prove it came from VoiceDesk:
//   X-VoiceDesk-Signature: sha256=HMAC_SHA256(secret, `${timestamp}.${body}`)
//   X-VoiceDesk-Timestamp: unix seconds
// Failed deliveries are retried by the scheduler (3 attempts in total).
import crypto from "node:crypto";
import net from "node:net";

export const EVENTS = ["call.completed", "appointment.booked", "appointment.changed", "lead.created", "order.placed", "callback.scheduled"];
const MAX_ATTEMPTS = 3;

export const http = { fetch: (...args) => fetch(...args) };

/** Only public https URLs: stops the server being used to reach internal systems. */
export function webhookUrlProblem(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return "Enter a full URL starting with https://";
  }
  if (process.env.ALLOW_LOCAL_WEBHOOKS === "1") return null; // local development and tests
  if (url.protocol !== "https:") return "Webhook URLs must start with https://";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    return "Webhook URLs must use a public domain name.";
  }
  return null;
}

export function sign(secret, timestamp, body) {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Record an event and deliver it to every webhook subscribed to it. */
export function emitEvent(db, orgId, type, data) {
  const hooks = db.find("webhooks", (w) => w.orgId === orgId && w.active && w.events.includes(type));
  for (const hook of hooks) {
    const delivery = db.insert("deliveries", {
      orgId, webhookId: hook.id, type, status: "pending", attempts: 0,
      body: JSON.stringify({ id: crypto.randomUUID(), type, created_at: new Date().toISOString(), data }),
    });
    deliver(db, delivery).catch(() => {});
  }
  return hooks.length;
}

export async function deliver(db, delivery) {
  const hook = db.get("webhooks", delivery.webhookId);
  if (!hook) return db.update("deliveries", delivery.id, { status: "failed", error: "Webhook was deleted" });
  const timestamp = Math.floor(Date.now() / 1000);
  const attempts = delivery.attempts + 1;
  try {
    const res = await http.fetch(hook.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        "content-type": "application/json",
        "user-agent": "VoiceDesk-Webhooks/1.0",
        "x-voicedesk-event": delivery.type,
        "x-voicedesk-timestamp": String(timestamp),
        "x-voicedesk-signature": sign(hook.secret, timestamp, delivery.body),
      },
      body: delivery.body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return db.update("deliveries", delivery.id, { status: "delivered", attempts, responseStatus: res.status, deliveredAt: new Date().toISOString() });
  } catch (err) {
    return db.update("deliveries", delivery.id, {
      status: attempts >= MAX_ATTEMPTS ? "failed" : "retrying", attempts, error: String(err.message || err).slice(0, 200),
      retryAt: new Date(Date.now() + attempts * 5 * 60e3).toISOString(),
    });
  }
}

export async function retryDeliveries(db, now = new Date()) {
  for (const d of db.find("deliveries", (x) => x.status === "retrying" && x.retryAt <= now.toISOString())) await deliver(db, d);
  // Keep the log small: drop finished deliveries older than 14 days.
  const cutoff = new Date(now.getTime() - 14 * 864e5).toISOString();
  db.find("deliveries", (x) => x.status !== "retrying" && x.createdAt < cutoff).forEach((x) => db.remove("deliveries", x.id));
}
