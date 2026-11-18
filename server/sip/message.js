// SIP messages (RFC 3261): parsing and building the text format that phone
// networks use to set up and end calls. Example request:
//
//   INVITE sip:+918047112233@trunk.example SIP/2.0
//   Via: SIP/2.0/UDP 203.0.113.5:5060;branch=z9hG4bK776asdhds
//   From: <sip:+919811111111@trunk.example>;tag=1928301774
//   To: <sip:+918047112233@trunk.example>
//   Call-ID: a84b4c76e66710
//   CSeq: 314159 INVITE
//   Content-Type: application/sdp
//   Content-Length: 142
//
//   (SDP body: which IP/port/codecs to send audio to)
import crypto from "node:crypto";

const COMPACT = { v: "via", f: "from", t: "to", i: "call-id", m: "contact", l: "content-length", c: "content-type", k: "supported", s: "subject", e: "content-encoding" };
const CANONICAL = {
  "via": "Via", "from": "From", "to": "To", "call-id": "Call-ID", "cseq": "CSeq", "contact": "Contact",
  "content-length": "Content-Length", "content-type": "Content-Type", "max-forwards": "Max-Forwards",
  "www-authenticate": "WWW-Authenticate", "proxy-authenticate": "Proxy-Authenticate", "authorization": "Authorization",
  "proxy-authorization": "Proxy-Authorization", "record-route": "Record-Route", "route": "Route", "user-agent": "User-Agent",
  "allow": "Allow", "supported": "Supported", "expires": "Expires", "refer-to": "Refer-To", "referred-by": "Referred-By",
  "p-asserted-identity": "P-Asserted-Identity", "server": "Server", "reason": "Reason",
};
// Headers that may hold several comma-separated values.
const MULTI = new Set(["via", "route", "record-route", "contact"]);

export const branch = () => `z9hG4bK${crypto.randomBytes(8).toString("hex")}`;
export const tag = () => crypto.randomBytes(6).toString("hex");
export const callId = () => crypto.randomBytes(12).toString("hex");

/** Splits on commas that are not inside <...> or quotes. */
function splitList(value) {
  const out = [];
  let depth = 0, quoted = false, start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' && value[i - 1] !== "\\") quoted = !quoted;
    else if (!quoted && ch === "<") depth++;
    else if (!quoted && ch === ">") depth--;
    else if (!quoted && depth === 0 && ch === ",") {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}

/** Parses a datagram into { method?, uri?, status?, reason?, headers: {lower: [values]}, body } or null. */
export function parse(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
  const split = text.indexOf("\r\n\r\n");
  const head = split === -1 ? text : text.slice(0, split);
  let body = split === -1 ? "" : text.slice(split + 4);
  const lines = head.split(/\r?\n/).reduce((acc, line) => {
    if (/^[ \t]/.test(line) && acc.length) acc[acc.length - 1] += ` ${line.trim()}`; // folded header
    else acc.push(line);
    return acc;
  }, []);
  const first = lines.shift() || "";
  const msg = { headers: {} };
  let m;
  if ((m = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/i.exec(first))) {
    msg.status = Number(m[1]);
    msg.reason = m[2];
  } else if ((m = /^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/i.exec(first))) {
    msg.method = m[1].toUpperCase();
    msg.uri = m[2];
  } else {
    return null;
  }
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    let name = line.slice(0, i).trim().toLowerCase();
    name = COMPACT[name] || name;
    const value = line.slice(i + 1).trim();
    const values = MULTI.has(name) ? splitList(value) : [value];
    (msg.headers[name] ??= []).push(...values);
  }
  const length = Number(msg.headers["content-length"]?.[0]);
  if (Number.isFinite(length) && length >= 0) body = Buffer.from(body, "utf8").subarray(0, length).toString("utf8");
  msg.body = body;
  return msg;
}

export const header = (msg, name) => msg.headers[name.toLowerCase()]?.[0] ?? "";
export const headers = (msg, name) => msg.headers[name.toLowerCase()] ?? [];

/** Serializes { method, uri } or { status, reason } plus ordered headers [[name, value]] and body. */
export function build({ method, uri, status, reason, headers: list = [], body = "" }) {
  const first = method ? `${method} ${uri} SIP/2.0` : `SIP/2.0 ${status} ${reason || REASONS[status] || ""}`.trimEnd();
  const lines = [first];
  for (const [name, value] of list) {
    if (value == null || name.toLowerCase() === "content-length") continue;
    lines.push(`${CANONICAL[name.toLowerCase()] || name}: ${value}`);
  }
  lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

/** A response to `req`, copying Via/From/To/Call-ID/CSeq as RFC 3261 requires. */
export function response(req, status, { toTag, extra = [], body = "", reason } = {}) {
  let to = header(req, "to");
  if (toTag && !/;\s*tag=/i.test(to)) to += `;tag=${toTag}`;
  return build({
    status, reason,
    headers: [
      ...headers(req, "via").map((v) => ["Via", v]),
      ...headers(req, "record-route").map((v) => ["Record-Route", v]),
      ["From", header(req, "from")],
      ["To", to],
      ["Call-ID", header(req, "call-id")],
      ["CSeq", header(req, "cseq")],
      ["Server", "VoiceDesk"],
      ...extra,
    ],
    body,
  });
}

export const REASONS = {
  100: "Trying", 180: "Ringing", 183: "Session Progress", 200: "OK", 202: "Accepted",
  401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 407: "Proxy Authentication Required",
  408: "Request Timeout", 480: "Temporarily Unavailable", 481: "Call/Transaction Does Not Exist", 486: "Busy Here",
  487: "Request Terminated", 488: "Not Acceptable Here", 500: "Server Internal Error", 503: "Service Unavailable", 603: "Decline",
};

/** Header parameter, e.g. param("<sip:a@b>;tag=xyz", "tag") → "xyz". */
export function param(value, name) {
  const m = new RegExp(`;\\s*${name}=([^;>,\\s]+)`, "i").exec(value || "");
  return m ? m[1].replace(/^"|"$/g, "") : "";
}

/** The URI inside a name-addr ("Alice" <sip:alice@x>;tag=1 → sip:alice@x). */
export function uriOf(value) {
  const m = /<([^>]+)>/.exec(value || "");
  return (m ? m[1] : String(value || "").split(";")[0]).trim();
}

/** sip:user@host:port;params → { user, host, port, params } */
export function parseUri(uri) {
  const m = /^sips?:(?:([^@;]+)@)?([^:;>]+)(?::(\d+))?(.*)$/i.exec(String(uri || "").trim());
  if (!m) return null;
  return { user: m[1] ? decodeURIComponent(m[1].split(":")[0]) : "", host: m[2], port: m[3] ? Number(m[3]) : 5060, params: m[4] || "" };
}

/** Via of a received message: where to send the response (honouring received/rport, RFC 3581). */
export function viaAddress(msg, rinfo) {
  const via = header(msg, "via");
  const m = /SIP\/2\.0\/\w+\s+([^;:\s]+)(?::(\d+))?/i.exec(via);
  const rport = /;\s*rport=(\d+)/i.exec(via);
  return {
    address: rinfo?.address || param(via, "received") || m?.[1],
    port: rport ? Number(rport[1]) : rinfo?.port || Number(m?.[2]) || 5060,
  };
}

// ---------- Digest authentication (RFC 2617 / 7616, MD5) ----------
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

export function parseChallenge(value) {
  const out = {};
  const body = String(value || "").replace(/^Digest\s+/i, "");
  for (const m of body.matchAll(/(\w+)=("([^"]*)"|[^,\s]+)/g)) out[m[1].toLowerCase()] = m[3] ?? m[2];
  return out;
}

/** The Authorization header value answering a challenge. */
export function digest({ challenge, method, uri, username, password, nc = 1 }) {
  const c = parseChallenge(challenge);
  const ha1 = md5(`${username}:${c.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = (c.qop || "").split(",").map((s) => s.trim()).includes("auth") ? "auth" : "";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const ncHex = nc.toString(16).padStart(8, "0");
  const response = qop ? md5(`${ha1}:${c.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${c.nonce}:${ha2}`);
  const parts = [`username="${username}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${uri}"`, `response="${response}"`, "algorithm=MD5"];
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce="${cnonce}"`);
  if (c.opaque) parts.push(`opaque="${c.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

/** Server side: checks an Authorization header against a password. */
export function verifyDigest({ authorization, method, password, realm, nonce }) {
  const a = parseChallenge(authorization);
  if (a.realm !== realm || a.nonce !== nonce) return false;
  const ha1 = md5(`${a.username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${a.uri}`);
  const expect = a.qop ? md5(`${ha1}:${nonce}:${a.nc}:${a.cnonce}:${a.qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  return expect === a.response;
}
