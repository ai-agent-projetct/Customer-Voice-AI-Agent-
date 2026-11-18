// Company Brain: one searchable vault of what the business knows.
//
// - Documents the owner adds (price lists, policies, menus, meeting notes, memos)
// - Every call and chat summary, automatically
//
// Each document is "public" (customers may be told it: the AI employees can
// search it during conversations) or "internal" (only the owner and team see
// it: searchable from the dashboard or by the owner over WhatsApp).
// Search is a small BM25 ranking over paragraph-sized chunks: no extra
// services needed, fine for thousands of documents.
import { aiEnabled, objectSchema, structured } from "./llm.js";

const CHUNK = 700;
const STOP = new Set("a an and are as at be by can do does for from has have how i in is it its me my of on or our so that the their them there this to was we what when where which who why will with you your".split(" "));

export function tokens(text) {
  return (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length > 1 && !STOP.has(t));
}

function chunks(doc) {
  const paras = String(doc.content).split(/\n\s*\n|(?<=\.)\s+(?=[A-Z])/);
  const out = [];
  let buf = "";
  for (const p of paras) {
    if ((buf + " " + p).length > CHUNK && buf) {
      out.push(buf.trim());
      buf = "";
    }
    buf += " " + p;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.map((text) => ({ docId: doc.id, title: doc.title, visibility: doc.visibility, source: doc.source, text }));
}

/** Documents a search may see: customer-facing searches never see internal ones. */
function corpus(db, orgId, { includeInternal, includeCalls }) {
  const docs = db.find("knowledge", (d) => d.orgId === orgId && (includeInternal || d.visibility === "public"));
  const all = docs.flatMap(chunks);
  if (includeCalls) {
    for (const c of db.find("calls", (x) => x.orgId === orgId && x.analysis?.summary && x.channel !== "simulation")) {
      all.push({ callId: c.id, title: `${c.channel === "phone" ? "Call" : "Chat"} ${c.createdAt.slice(0, 10)}${c.callerNumber ? ` · ${c.callerNumber}` : ""}`, visibility: "internal", source: "conversation", text: c.analysis.summary + (c.analysis.followUpNote ? ` Next: ${c.analysis.followUpNote}` : "") });
    }
  }
  return all;
}

/** Best matching passages for a query. */
export function searchBrain(db, orgId, query, { includeInternal = false, includeCalls = false, limit = 4 } = {}) {
  const docs = corpus(db, orgId, { includeInternal, includeCalls });
  const q = [...new Set(tokens(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map((d) => tokens(`${d.title} ${d.text}`));
  const avg = toks.reduce((s, t) => s + t.length, 0) / toks.length;
  const df = Object.fromEntries(q.map((term) => [term, toks.filter((t) => t.includes(term)).length]));
  const scored = docs.map((d, i) => {
    const t = toks[i];
    let score = 0;
    let matched = 0;
    for (const term of q) {
      const f = t.filter((x) => x === term || (term.length > 4 && x.startsWith(term.slice(0, -1)))).length;
      if (!f) continue;
      matched++;
      const idf = Math.log(1 + (docs.length - df[term] + 0.5) / (df[term] + 0.5));
      score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (t.length / avg))));
    }
    return { ...d, score, matched, coverage: matched / q.length };
  });
  return scored.filter((d) => d.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Answer a question from the vault, citing sources. The owner's version:
 * internal documents and conversation summaries included.
 */
export async function askBrain(db, orgId, question) {
  const hits = searchBrain(db, orgId, question, { includeInternal: true, includeCalls: true, limit: 6 });
  const sources = hits.map((h, i) => ({ n: i + 1, title: h.title, docId: h.docId ?? null, callId: h.callId ?? null, excerpt: h.text.slice(0, 280) }));
  if (!hits.length) return { answer: "I couldn't find anything about that in your Company Brain yet. Add a document, or ask in other words.", sources: [] };
  if (!aiEnabled()) {
    return { answer: `Here's what I found:\n${hits.slice(0, 3).map((h, i) => `[${i + 1}] ${h.text.slice(0, 220)}${h.text.length > 220 ? "…" : ""}`).join("\n")}`, sources, demo: true };
  }
  const out = await structured({
    system: "You answer a small-business owner's questions using only the passages from their own company knowledge vault. Cite passages like [2]. If the passages don't answer it, say so plainly. Be brief.",
    prompt: `${hits.map((h, i) => `[${i + 1}] (${h.title})\n${h.text}`).join("\n\n")}\n\nQuestion: ${question}`,
    schema: objectSchema({ answer: { type: "string" } }),
    effort: "low",
  });
  return { answer: out.answer, sources };
}
