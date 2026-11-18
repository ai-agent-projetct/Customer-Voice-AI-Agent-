// Automations: the AI employees' recurring jobs, run by the scheduler.
//
//   codConfirm     A cash-on-delivery order arrives (from the shop's website
//                  via the API): WhatsApp the customer to confirm, then an AI
//                  call if there's no answer. Cuts fake orders and returns.
//   abandonedCart  A checkout is left unfinished: WhatsApp reminder with the
//                  link, then an AI call if the customer agreed to be called.
//   leadFollowUp   New leads get follow-ups (WhatsApp / AI call) on a
//                  schedule until someone marks them contacted, won or lost.
//
// The same safety rules as campaigns: never to do-not-call numbers, messages
// and calls only between 9am and 9pm, and calls only with consent.
import { findCustomer } from "./customers.js";
import { queueMessage } from "./messaging.js";
import { queueAiCall } from "./outbound.js";
import { localParts } from "./util.js";

export const AUTOMATION_DEFAULTS = {
  codConfirm: { enabled: false, messageAfterMinutes: 5, callAfterMinutes: 120 },
  abandonedCart: { enabled: false, messageAfterMinutes: 30, callAfterMinutes: 240 },
  leadFollowUp: {
    enabled: false,
    steps: [
      { afterHours: 0, channel: "whatsapp" },
      { afterHours: 24, channel: "call" },
      { afterHours: 72, channel: "whatsapp" },
    ],
  },
};

export function automationsOf(org) {
  const saved = org.automations || {};
  return Object.fromEntries(Object.entries(AUTOMATION_DEFAULTS).map(([k, v]) => [k, { ...structuredClone(v), ...(saved[k] || {}) }]));
}

const minutesSince = (iso, now) => (now.getTime() - Date.parse(iso)) / 60e3;
const firstName = (name) => String(name || "").split(/\s+/)[0] || "there";

function allowed(db, org, phone, now) {
  const { time } = localParts(org.timeZone || "Asia/Kolkata", now);
  if (time < "09:00" || time >= "21:00") return false;
  return !findCustomer(db, org.id, phone)?.doNotCall;
}

function salesAgent(db, org) {
  const agents = db.find("agents", (a) => a.orgId === org.id && a.active);
  return agents.find((a) => a.role === "sales") ?? agents[0];
}

export async function runAutomations(db, now = new Date()) {
  for (const org of db.data.orgs) {
    const auto = automationsOf(org);
    const agent = salesAgent(db, org);
    if (!agent) continue;

    if (auto.codConfirm.enabled) {
      for (const order of db.find("orders", (o) => o.orgId === org.id && o.status === "awaiting_confirmation")) {
        if (!allowed(db, org, order.phone, now)) continue;
        const age = minutesSince(order.createdAt, now);
        if (!order.codMessagedAt && age >= auto.codConfirm.messageAfterMinutes) {
          db.update("orders", order.id, { codMessagedAt: now.toISOString() });
          queueMessage(db, {
            orgId: org.id, to: order.phone, kind: "cod_confirm", channel: "whatsapp",
            body: `Hi ${firstName(order.customerName)}, thanks for your order ${order.ref} from ${org.name}: ${order.items.map((i) => `${i.quantity} × ${i.name}`).join(", ")}, ₹${order.total} cash on delivery. Reply YES to confirm or NO to cancel.`,
          });
        } else if (order.codMessagedAt && !order.codCallQueuedAt && order.consent && age >= auto.codConfirm.callAfterMinutes) {
          db.update("orders", order.id, { codCallQueuedAt: now.toISOString() });
          queueAiCall(db, agent, {
            phone: order.phone, name: order.customerName, source: "automation", consent: true,
            reason: `Confirm cash-on-delivery order ${order.ref}`,
            goal: `Confirm cash-on-delivery order ${order.ref} (${order.items.map((i) => `${i.quantity} × ${i.name}`).join(", ")}, ₹${order.total}${order.address ? `, delivery to ${order.address}` : ""}). Ask if they still want it, then use confirm_order with their answer.`,
          });
        }
      }
    }

    if (auto.abandonedCart.enabled) {
      for (const cart of db.find("carts", (c) => c.orgId === org.id && c.status === "abandoned")) {
        if (!allowed(db, org, cart.phone, now)) continue;
        const age = minutesSince(cart.createdAt, now);
        if (!cart.messagedAt && age >= auto.abandonedCart.messageAfterMinutes) {
          db.update("carts", cart.id, { messagedAt: now.toISOString() });
          queueMessage(db, {
            orgId: org.id, to: cart.phone, kind: "cart_reminder", channel: "whatsapp",
            body: `Hi ${firstName(cart.customerName)}, you left ${cart.items.map((i) => i.name).join(", ")} in your cart at ${org.name}.${cart.checkoutUrl ? ` Finish your order here: ${cart.checkoutUrl}` : ""} Any questions? Just reply.`,
          });
        } else if (cart.messagedAt && !cart.callQueuedAt && cart.consent && age >= auto.abandonedCart.callAfterMinutes) {
          db.update("carts", cart.id, { callQueuedAt: now.toISOString() });
          queueAiCall(db, agent, {
            phone: cart.phone, name: cart.customerName, source: "automation", consent: true,
            reason: "Items left in cart",
            goal: `The customer left ${cart.items.map((i) => i.name).join(", ")} (₹${cart.total}) in their cart. Ask if they had a question or a problem at checkout, help them, and offer to send the checkout link on WhatsApp. Don't push.`,
          });
        }
      }
    }

    if (auto.leadFollowUp.enabled) {
      const steps = auto.leadFollowUp.steps;
      for (const lead of db.find("leads", (l) => l.orgId === org.id && l.status === "new" && l.phone && !["simulation", "web"].includes(l.source))) {
        const step = lead.followUpStep || 0;
        if (step >= steps.length) continue;
        if (minutesSince(lead.createdAt, now) < steps[step].afterHours * 60) continue;
        if (!allowed(db, org, lead.phone, now)) continue;
        db.update("leads", lead.id, { followUpStep: step + 1, lastFollowUpAt: now.toISOString() });
        if (steps[step].channel === "call") {
          if (!lead.consent) continue; // calls need consent; WhatsApp steps still run
          queueAiCall(db, agent, {
            phone: lead.phone, name: lead.customerName, source: "automation", consent: true, leadId: lead.id,
            reason: `Follow up: ${lead.interest}`,
            goal: `Follow up on their enquiry about ${lead.interest}. ${lead.notes || ""} Answer questions and book an appointment or take an order if they're ready. If not interested, thank them and end the call.`,
          });
        } else {
          queueMessage(db, {
            orgId: org.id, to: lead.phone, kind: "lead_follow_up", channel: "whatsapp",
            body: `Hi ${firstName(lead.customerName)}, thanks for your interest in ${lead.interest} at ${org.name}. Can I help you with anything or book a time for you? Just reply here.`,
          });
        }
      }
    }
  }
}
