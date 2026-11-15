// The actions an agent can take during a call. Claude decides *when* to use
// them; this file decides *what actually happens* and enforces the business
// rules (no double-booking, opening hours, privacy of other people's bookings).
import crypto from "node:crypto";
import { DEFAULT_HOURS, normalizeServices } from "./catalog.js";
import { findCustomer, upsertCustomer } from "./customers.js";
import { agentLanguages, lang } from "./languages.js";
import { notifyOwner, queueMessage } from "./messaging.js";
import { emitEvent } from "./webhooks.js";
import { localParts, samePhone, toHHMM, toMinutes, todayIn } from "./util.js";

export { todayIn };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function weekday(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function freeSlots(db, agent, date, ignoreId = null) {
  const hours = agent.hours ?? DEFAULT_HOURS;
  if (!hours.days.includes(weekday(date))) return [];
  const taken = new Set(
    db
      .find("appointments", (a) => a.agentId === agent.id && a.date === date && a.status === "confirmed" && a.id !== ignoreId && a.source !== "simulation")
      .map((a) => a.time),
  );
  const now = localParts(agent.timeZone);
  const slots = [];
  for (let t = toMinutes(hours.open); t + hours.slotMinutes <= toMinutes(hours.close); t += hours.slotMinutes) {
    const time = toHHMM(t);
    if (date === now.date && time <= now.time) continue; // already passed today
    if (!taken.has(time)) slots.push(time);
  }
  return slots;
}

const str = (description) => ({ type: "string", ...(description && { description }) });
function tool(name, description, properties) {
  return {
    name,
    description,
    strict: true,
    input_schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
  };
}

// Tool definitions sent to Claude. `strict: true` guarantees arguments match the schema.
export function toolDefinitions(agent, org, call) {
  const tools = [];
  if (agent.bookingEnabled) {
    tools.push(
      tool("check_availability", "List free appointment slots on a date. Always check before offering times.", { date: str("YYYY-MM-DD") }),
      tool(
        "book_appointment",
        "Book a slot once the caller has confirmed date, time, name and phone number. Read the details back before booking.",
        { customer_name: str(), phone: str(), date: str("YYYY-MM-DD"), time: str("HH:MM, 24-hour"), service: str(), notes: str() },
      ),
      tool("find_appointments", "Look up the caller's upcoming bookings (needed before cancelling or rescheduling).", {
        phone: str("The phone number the booking was made with"),
        customer_name: str(),
      }),
      tool("cancel_appointment", "Cancel one of the caller's bookings after they confirm.", { reference: str("Booking reference from find_appointments") }),
      tool("reschedule_appointment", "Move one of the caller's bookings to a new free slot after they confirm.", {
        reference: str(),
        date: str("YYYY-MM-DD"),
        time: str("HH:MM"),
      }),
    );
  }
  tools.push(
    tool(
      "save_lead",
      "Save the caller's details for the owner to follow up: whenever a caller shows interest, wants a callback, or leaves a message.",
      { customer_name: str(), phone: str(), interest: str("What they want, in a few words"), notes: str("Budget, timing, message, anything useful") },
    ),
    tool(
      "note_unanswered_question",
      "Record a question you could not answer from the business information, so the owner can add the answer. Use it every time you don't know something.",
      { question: str("The caller's question, written clearly") },
    ),
    tool(
      "alert_owner",
      "Notify the business owner right away: emergencies, an upset customer, a large order or a very hot lead.",
      { reason: str("What happened, in one or two sentences"), urgency: { type: "string", enum: ["urgent", "normal"] } },
    ),
  );
  if ((org?.followUpChannel ?? "whatsapp") !== "off") {
    tools.push(
      tool(
        "send_info_message",
        `Send the caller a ${org?.followUpChannel === "sms" ? "text message" : "WhatsApp message"} with information they asked for (address, price list, menu, directions). Offer it first.`,
        { phone: str(), message: str("Short, complete message text") },
      ),
    );
  }
  const languages = agentLanguages(agent);
  if (languages.length > 1) {
    tools.push({
      ...tool("switch_language", "Switch the call to another language you speak, when the caller asks for it or clearly starts speaking it. Then continue in that language.", {
        language: { type: "string", enum: languages, description: languages.map((c) => `${c} = ${lang(c).name}`).join(", ") },
      }),
    });
  }
  if (call?.callerNumber) {
    tools.push(tool("do_not_call", "The caller asked never to be called again. Respect it immediately.", { reason: str() }));
  }
  const departments = (agent.departments || []).filter((d) => d.name && d.number);
  if (departments.length) {
    tools.push(tool("transfer_to_human", "Transfer the call to the right team when the caller asks for it, insists on a person, or you cannot help.", {
      department: { type: "string", enum: [...departments.map((d) => d.name), "General"], description: "Which team should take the call" },
      reason: str(),
    }));
  } else if (agent.transferNumber || org?.ownerPhone) {
    tools.push(tool("transfer_to_human", "Transfer the call to a staff member when the caller insists on a person or you cannot help.", { reason: str() }));
  }
  if (call?.channel !== "simulation") {
    tools.push(tool("schedule_callback", "The caller asked to be called back later. Schedule the call for the time they want (calls are only made between 9am and 9pm).", {
      phone: str(), date: str("YYYY-MM-DD"), time: str("HH:MM, 24-hour"), reason: str("What the callback is about"),
    }));
  }
  if (agent.ordersEnabled) {
    tools.push(tool("place_order", "Place the caller's order after reading it back and getting a yes. Only items from the services and prices list can be ordered.", {
      customer_name: str(), phone: str(),
      items: { type: "array", items: { type: "object", properties: { name: str("Exact item name"), quantity: { type: "integer" } }, required: ["name", "quantity"], additionalProperties: false } },
      fulfilment: { type: "string", enum: ["pickup", "delivery"] },
      address: str("Delivery address, or empty for pickup"),
      notes: str(),
    }));
  }
  tools.push(tool("end_call", "Hang up after you have said goodbye and the caller has nothing else they need.", { summary: str("One-sentence summary of the call") }));
  return tools;
}

// On a phone call we only reveal bookings made from the caller's own number.
// On web/widget chats the caller must give both the phone and the name used.
function ownsAppointment(call, appt, phone, name) {
  if (call.callerNumber) return samePhone(appt.phone, call.callerNumber);
  const first = (s) => String(s ?? "").trim().toLowerCase().split(/\s+/)[0];
  return samePhone(appt.phone, phone) && first(appt.customerName) === first(name) && first(name) !== "";
}

function slotProblem(db, agent, date, time, ignoreId) {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) return "Error: date must be YYYY-MM-DD and time HH:MM.";
  if (date < todayIn(agent.timeZone)) return "That date is in the past.";
  if (!freeSlots(db, agent, date, ignoreId).includes(time)) return "That slot is not available. Check availability and offer another time.";
  return null;
}

function servicePrice(agent, name) {
  const match = normalizeServices(agent.services).find((s) => s.name.toLowerCase() === String(name).toLowerCase());
  return match?.price ?? 0;
}

/** Runs one tool call. Returns { result: text for Claude, action?: call control }. */
export function runTool(db, agent, call, name, input) {
  const org = db.get("orgs", agent.orgId);
  const today = todayIn(agent.timeZone);
  const sendConfirmation = (appt, verb) =>
    queueMessage(db, {
      orgId: agent.orgId,
      to: appt.phone,
      kind: `booking_${verb}`,
      call,
      body: `${org?.name ?? agent.name}: your ${appt.service} booking is ${verb} for ${appt.date} at ${appt.time}. Ref ${appt.ref}. Reply or call us to change it.`,
    });

  switch (name) {
    case "check_availability": {
      if (!DATE_RE.test(input.date)) return { result: "Error: date must be YYYY-MM-DD." };
      if (input.date < today) return { result: "That date is in the past." };
      const slots = freeSlots(db, agent, input.date);
      const day = DAY_NAMES[weekday(input.date)];
      return {
        result: slots.length
          ? `${day} ${input.date}: free slots ${slots.join(", ")}.`
          : `${day} ${input.date}: closed or fully booked. Suggest another day.`,
      };
    }
    case "book_appointment": {
      const problem = slotProblem(db, agent, input.date, input.time);
      if (problem) return { result: problem };
      const appt = db.insert("appointments", {
        orgId: agent.orgId,
        agentId: agent.id,
        callId: call.id,
        ref: crypto.randomBytes(3).toString("hex").toUpperCase(),
        customerName: input.customer_name,
        phone: input.phone,
        date: input.date,
        time: input.time,
        service: input.service,
        price: servicePrice(agent, input.service),
        notes: input.notes,
        status: "confirmed",
        reminded: false,
        source: call.channel,
      });
      rememberCaller(db, agent, call, input.phone, input.customer_name);
      emitEvent(db, agent.orgId, "appointment.booked", appt);
      const msg = sendConfirmation(appt, "confirmed");
      return { result: `Booked. Reference ${appt.ref}.${msg ? " A confirmation message is being sent." : ""}` };
    }
    case "find_appointments": {
      const upcoming = db
        .find("appointments", (a) => a.agentId === agent.id && a.status === "confirmed" && a.date >= today)
        .filter((a) => ownsAppointment(call, a, input.phone, input.customer_name));
      if (!upcoming.length) return { result: "No upcoming bookings found for this caller. (Bookings are matched by phone number and name.)" };
      // Remember which bookings this conversation proved it owns (used by cancel/reschedule on web chats).
      call.verifiedRefs = [...new Set([...(call.verifiedRefs || []), ...upcoming.map((a) => a.ref)])];
      return { result: upcoming.map((a) => `Ref ${a.ref}: ${a.service} on ${a.date} at ${a.time}`).join("; ") };
    }
    case "cancel_appointment":
    case "reschedule_appointment": {
      const appt = db.find("appointments", (a) => a.agentId === agent.id && a.ref === String(input.reference).toUpperCase() && a.status === "confirmed")[0];
      if (!appt || !(call.callerNumber ? samePhone(appt.phone, call.callerNumber) : call.verifiedRefs?.includes(appt.ref))) {
        return { result: "Booking not found for this caller. Use find_appointments first." };
      }
      if (name === "cancel_appointment") {
        emitEvent(db, agent.orgId, "appointment.changed", db.update("appointments", appt.id, { status: "cancelled" }));
        sendConfirmation(appt, "cancelled");
        return { result: `Cancelled booking ${appt.ref}.` };
      }
      const problem = slotProblem(db, agent, input.date, input.time, appt.id);
      if (problem) return { result: problem };
      const moved = db.update("appointments", appt.id, { date: input.date, time: input.time, reminded: false });
      emitEvent(db, agent.orgId, "appointment.changed", moved);
      sendConfirmation(moved, "moved");
      return { result: `Moved booking ${appt.ref} to ${input.date} ${input.time}.` };
    }
    case "save_lead": {
      db.insert("leads", {
        orgId: agent.orgId,
        agentId: agent.id,
        callId: call.id,
        customerName: input.customer_name,
        phone: input.phone,
        interest: input.interest,
        notes: input.notes,
        status: "new",
        score: null,
        source: call.channel,
      });
      rememberCaller(db, agent, call, input.phone, input.customer_name);
      emitEvent(db, agent.orgId, "lead.created", db.find("leads", (l) => l.callId === call.id).at(-1));
      return { result: "Saved. The team will follow up." };
    }
    case "note_unanswered_question": {
      const question = String(input.question).trim().slice(0, 500);
      const dup = db.find("questions", (q) => q.agentId === agent.id && q.status === "open" && q.question.toLowerCase() === question.toLowerCase())[0];
      if (dup) db.update("questions", dup.id, { count: (dup.count || 1) + 1 });
      else db.insert("questions", { orgId: agent.orgId, agentId: agent.id, callId: call.id, question, status: "open", count: 1, answer: "" });
      return { result: "Noted for the owner. Tell the caller honestly you don't have that information, and offer to take a message." };
    }
    case "alert_owner": {
      notifyOwner(db, agent.orgId, {
        kind: "alert",
        title: input.urgency === "urgent" ? "Urgent call needs you" : "Call needs your attention",
        body: `${input.reason}${call.callerNumber ? `\nCaller: ${call.callerNumber}` : ""}`,
        callId: call.id,
        urgent: input.urgency === "urgent",
      });
      return { result: "The owner has been notified." };
    }
    case "send_info_message": {
      const msg = queueMessage(db, { orgId: agent.orgId, to: input.phone, kind: "info", call, body: `${org?.name ?? agent.name}: ${input.message}` });
      return { result: msg ? "Message is being sent." : "Messaging is switched off for this business; read the information out instead." };
    }
    case "do_not_call": {
      upsertCustomer(db, agent.orgId, call.callerNumber, { doNotCall: true, doNotCallReason: input.reason, doNotCallAt: new Date().toISOString() });
      return { result: "Done: this number will not be called again. Apologise briefly and end the call politely." };
    }
    case "switch_language": {
      if (!agentLanguages(agent).includes(input.language)) return { result: "That language isn't available. Continue in the current language." };
      switchLanguage(db, agent, call, input.language, "tool");
      return { result: `Switched. The caller now hears the ${lang(input.language).name} voice: reply only in ${lang(input.language).name}.` };
    }
    case "transfer_to_human": {
      const dept = (agent.departments || []).find((d) => d.name === input.department && d.number);
      return {
        result: `Transferring now${dept ? ` to ${dept.name}` : ""}. Tell the caller you are connecting them.`,
        action: { type: "transfer", reason: input.reason, department: dept?.name, number: dept?.number },
      };
    }
    case "schedule_callback": {
      if (!DATE_RE.test(input.date) || !TIME_RE.test(input.time)) return { result: "Error: date must be YYYY-MM-DD and time HH:MM." };
      const now = localParts(agent.timeZone);
      if (input.date < now.date || (input.date === now.date && input.time <= now.time)) return { result: "That time has already passed. Ask for a later time." };
      if (input.time < "09:00" || input.time >= "21:00") return { result: "Callbacks can only be made between 9am and 9pm. Ask for a time in that window." };
      const phone = call.callerNumber || input.phone;
      if (findCustomer(db, agent.orgId, phone)?.doNotCall) return { result: "This number is on the do-not-call list, so no callback can be scheduled." };
      db.insert("callbacks", { orgId: agent.orgId, agentId: agent.id, callId: call.id, phone, date: input.date, time: input.time, reason: input.reason, language: call.language ?? agent.language, status: "pending", source: call.channel });
      emitEvent(db, agent.orgId, "callback.scheduled", { phone, date: input.date, time: input.time, reason: input.reason });
      return { result: `Callback scheduled for ${input.date} at ${input.time}. Confirm the time with the caller.` };
    }
    case "place_order": {
      const menu = normalizeServices(agent.services);
      const lines = [];
      for (const item of input.items || []) {
        const match = menu.find((m) => m.name.toLowerCase() === String(item.name).toLowerCase());
        if (!match) return { result: `"${item.name}" is not on the list. Available: ${menu.map((m) => m.name).join(", ")}.` };
        if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) return { result: "Quantity must be between 1 and 100." };
        lines.push({ name: match.name, quantity: item.quantity, price: match.price });
      }
      if (!lines.length) return { result: "The order has no items." };
      if (input.fulfilment === "delivery" && !String(input.address || "").trim()) return { result: "Ask for the delivery address first." };
      const total = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
      const order = db.insert("orders", {
        orgId: agent.orgId, agentId: agent.id, callId: call.id, ref: crypto.randomBytes(3).toString("hex").toUpperCase(),
        customerName: input.customer_name, phone: input.phone, items: lines, total, fulfilment: input.fulfilment,
        address: input.address, notes: input.notes, status: "new", source: call.channel,
      });
      rememberCaller(db, agent, call, input.phone, input.customer_name);
      notifyOwner(db, agent.orgId, { kind: "order", title: `New order ${order.ref}: ₹${total}`, body: `${lines.map((l) => `${l.quantity} × ${l.name}`).join(", ")} for ${input.customer_name} (${input.fulfilment})`, callId: call.id });
      queueMessage(db, { orgId: agent.orgId, to: input.phone, kind: "order_confirmed", call, body: `${org?.name ?? agent.name}: order ${order.ref} confirmed. ${lines.map((l) => `${l.quantity} × ${l.name}`).join(", ")}. Total ₹${total}.` });
      emitEvent(db, agent.orgId, "order.placed", order);
      return { result: `Order placed. Reference ${order.ref}. Total ${total} rupees.` };
    }
    case "end_call":
      return { result: "Call will end after your goodbye.", action: { type: "hangup", summary: input.summary } };
    default:
      return { result: `Unknown tool ${name}.` };
  }
}

// Learn the caller's name for next time (phone calls only: that's how we recognise them).
function rememberCaller(db, agent, call, phone, name) {
  if (!call.callerNumber || !samePhone(phone, call.callerNumber)) return;
  const existing = findCustomer(db, agent.orgId, call.callerNumber);
  if (existing && !existing.name && name) db.update("customers", existing.id, { name });
}


/**
 * Change the language of a live call: speech recognition and the voice follow
 * call.language, and callers with a phone number get it remembered for next time.
 */
export function switchLanguage(db, agent, call, code, reason = "tool") {
  if (!agentLanguages(agent).includes(code) || call.language === code) return false;
  call.language = code;
  call.languageLog = [...(call.languageLog || []), { code, reason, turn: call.transcript?.length ?? 0, at: new Date().toISOString() }];
  if (call.id && db.get("calls", call.id)) db.update("calls", call.id, { language: code, languageLog: call.languageLog });
  if (call.callerNumber) upsertCustomer(db, agent.orgId, call.callerNumber, { preferredLanguage: code });
  return true;
}
