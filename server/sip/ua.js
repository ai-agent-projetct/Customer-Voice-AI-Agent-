// VoiceDesk's SIP user agent: answers and places phone calls over a SIP
// trunk from a licensed operator, with no third-party voice platform in
// between. UDP transport, RFC 3261 transactions with retransmission, digest
// authentication, registration, CANCEL/BYE, re-INVITE, keypad via RTP events
// or SIP INFO. Media (RTP) is handled per call by rtp.js.
//
// Events:  "invite" (IncomingCall)   "registered" ({expires})   "error" (Error)
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { branch, build, callId as newCallId, digest, header, headers, param, parse, parseUri, response, tag as newTag, uriOf } from "./message.js";
import { RtpSession, bindRtpSocket } from "./rtp.js";
import { buildSdp, chooseCodec, parseSdp } from "./sdp.js";

const T1 = 500;
const T2 = 4000;
const ALLOW = "INVITE, ACK, CANCEL, BYE, OPTIONS, INFO";

export class SipUA extends EventEmitter {
  /**
   * opts: { port, host, publicIp, rtp: {min,max}, trunk: { host, port, username, password, domain, register },
   *         allow(rinfo) → boolean  (which addresses may send us calls) }
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.trunk = opts.trunk || {};
    this.calls = new Map(); // Call-ID → Leg
    this.clientTx = new Map(); // branch → transaction
    this.serverTx = new Map(); // INVITE branch → last response text (for retransmitted INVITEs)
  }

  async start() {
    this.socket = dgram.createSocket("udp4");
    this.socket.on("message", (buf, rinfo) => {
      try { this.receive(buf, rinfo); } catch (err) { this.emit("error", err); }
    });
    this.socket.on("error", (err) => this.emit("error", err));
    await new Promise((resolve, reject) => {
      this.socket.once("error", reject);
      this.socket.bind(this.opts.port ?? 5060, this.opts.host || "0.0.0.0", resolve);
    });
    this.port = this.socket.address().port;
    this.ip = this.opts.publicIp || (this.opts.host && this.opts.host !== "0.0.0.0" ? this.opts.host : "127.0.0.1");
    if (this.trunk.register && this.trunk.host) this.register().catch((err) => this.emit("error", err));
    return this;
  }

  stop() {
    clearTimeout(this.registerTimer);
    for (const leg of this.calls.values()) leg.end("shutdown");
    for (const tx of this.clientTx.values()) clearTimeout(tx.timer);
    try { this.socket?.close(); } catch {}
  }

  get domain() {
    return this.trunk.domain || this.trunk.host || this.ip;
  }

  get contact() {
    return `<sip:${this.trunk.username || "voicedesk"}@${this.ip}:${this.port}>`;
  }

  via(b) {
    return `SIP/2.0/UDP ${this.ip}:${this.port};branch=${b};rport`;
  }

  sendRaw(text, port, address) {
    if (process.env.SIP_DEBUG) console.log(`SIP → ${address}:${port}\n${text}`);
    this.socket.send(Buffer.from(text), port, address);
  }

  // ---------------- Receiving ----------------
  receive(buf, rinfo) {
    if (buf.length < 4 || buf.toString("ascii", 0, 4) === "\r\n\r\n") return; // keep-alive
    if (process.env.SIP_DEBUG) console.log(`SIP ← ${rinfo.address}:${rinfo.port}\n${buf}`);
    const msg = parse(buf);
    if (!msg) return;
    if (msg.status) return this.onResponse(msg, rinfo);
    const allow = this.opts.allow;
    const id = header(msg, "call-id");
    const known = this.calls.get(id);
    if (msg.method === "INVITE" && !known && allow && !allow(rinfo)) {
      return this.sendRaw(response(msg, 403, { toTag: newTag() }), rinfo.port, rinfo.address);
    }
    switch (msg.method) {
      case "INVITE": return this.onInvite(msg, rinfo, known);
      case "ACK": return known?.onAck(msg);
      case "BYE": {
        this.sendRaw(response(msg, known ? 200 : 481), rinfo.port, rinfo.address);
        return known?.end("remote-bye");
      }
      case "CANCEL": {
        this.sendRaw(response(msg, known ? 200 : 481), rinfo.port, rinfo.address);
        return known?.onCancel();
      }
      case "OPTIONS":
        return this.sendRaw(response(msg, 200, { extra: [["Allow", ALLOW], ["Accept", "application/sdp"]] }), rinfo.port, rinfo.address);
      case "INFO": {
        this.sendRaw(response(msg, known ? 200 : 481), rinfo.port, rinfo.address);
        const signal = /Signal\s*=\s*([0-9*#A-D])/i.exec(msg.body || "");
        if (known && signal) known.rtp?.onDtmf?.(signal[1].toUpperCase());
        return;
      }
      default:
        return this.sendRaw(response(msg, 405, { extra: [["Allow", ALLOW]] }), rinfo.port, rinfo.address);
    }
  }

  async onInvite(msg, rinfo, known) {
    const via = header(msg, "via");
    const b = param(via, "branch");
    const toTag = param(header(msg, "to"), "tag");
    if (known && toTag) return known.onReinvite(msg, rinfo); // re-INVITE inside the call
    if (known || this.serverTx.has(b)) {
      const last = this.serverTx.get(b);
      if (last) this.sendRaw(last, rinfo.port, rinfo.address); // retransmitted INVITE
      return;
    }
    this.sendRaw(response(msg, 100), rinfo.port, rinfo.address);
    const leg = new Leg(this, { direction: "inbound", callId: header(msg, "call-id"), invite: msg, dest: { address: rinfo.address, port: rinfo.port } });
    this.calls.set(leg.callId, leg);
    this.serverTx.set(b, null);
    const timer = setTimeout(() => this.serverTx.delete(b), 64 * T1);
    timer.unref?.();
    this.emit("invite", leg);
  }

  onResponse(msg, rinfo) {
    const b = param(header(msg, "via"), "branch");
    const tx = this.clientTx.get(b);
    // CANCEL shares the INVITE's branch: match on the method too (RFC 3261 §17.1.3).
    const method = header(msg, "cseq").split(/\s+/)[1]?.toUpperCase();
    if (tx && tx.method === method) return tx.onResponse(msg, rinfo);
    if (tx) return;
    // A retransmitted 200 OK for an INVITE we already ACKed: ACK again.
    const leg = this.calls.get(header(msg, "call-id"));
    if (leg && msg.status >= 200 && msg.status < 300 && /INVITE/i.test(header(msg, "cseq")) && leg.lastAck) {
      this.sendRaw(leg.lastAck, leg.dest.port, leg.dest.address);
    }
  }

  // ---------------- Client transactions ----------------
  /** Sends a request, retransmitting over UDP; resolves with the final response. onProvisional for 1xx. */
  transaction({ text, b, method, dest, onProvisional }) {
    return new Promise((resolve) => {
      let interval = T1;
      let gotProvisional = false;
      const started = Date.now();
      const tx = {
        method,
        onResponse: (msg) => {
          if (msg.status < 200) {
            gotProvisional = true;
            if (method === "INVITE") clearTimeout(tx.timer);
            onProvisional?.(msg);
            return;
          }
          clearTimeout(tx.timer);
          this.clientTx.delete(b);
          resolve(msg);
        },
      };
      const send = () => {
        this.sendRaw(text, dest.port, dest.address);
        if (Date.now() - started >= 64 * T1) {
          this.clientTx.delete(b);
          return resolve({ status: 408, reason: "Request Timeout", headers: {}, body: "" });
        }
        if (method === "INVITE" && gotProvisional) return;
        tx.timer = setTimeout(send, interval);
        tx.timer.unref?.();
        interval = method === "INVITE" ? interval * 2 : Math.min(interval * 2, T2);
      };
      this.clientTx.set(b, tx);
      send();
      // INVITE with provisional: wait up to the ring timeout for a final answer.
      if (method === "INVITE") {
        const ring = setTimeout(() => {
          if (this.clientTx.has(b)) {
            this.clientTx.delete(b);
            clearTimeout(tx.timer);
            resolve({ status: 408, reason: "No answer", headers: {}, body: "", timedOut: true });
          }
        }, this.opts.ringTimeoutMs ?? 45000);
        ring.unref?.();
      }
    });
  }

  trunkDest() {
    return { address: this.trunk.host, port: Number(this.trunk.port) || 5060 };
  }

  // ---------------- Registration ----------------
  async register(expires = 300) {
    const dest = this.trunkDest();
    const uri = `sip:${this.domain}`;
    const aor = `<sip:${this.trunk.username}@${this.domain}>`;
    const id = this.registerCallId ??= newCallId();
    const fromTag = this.registerTag ??= newTag();
    let auth = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      this.registerCseq = (this.registerCseq || 0) + 1;
      const b = branch();
      const text = build({
        method: "REGISTER", uri,
        headers: [["Via", this.via(b)], ["Max-Forwards", "70"], ["From", `${aor};tag=${fromTag}`], ["To", aor], ["Call-ID", id],
          ["CSeq", `${this.registerCseq} REGISTER`], ["Contact", this.contact], ["Expires", String(expires)], ["User-Agent", "VoiceDesk"],
          ...(auth ? [[auth.header, auth.value]] : [])],
      });
      const res = await this.transaction({ text, b, method: "REGISTER", dest });
      if (res.status === 401 || res.status === 407) {
        const challengeHeader = res.status === 401 ? "www-authenticate" : "proxy-authenticate";
        auth = { header: res.status === 401 ? "Authorization" : "Proxy-Authorization", value: digest({ challenge: header(res, challengeHeader), method: "REGISTER", uri, username: this.trunk.authUser || this.trunk.username, password: this.trunk.password }) };
        continue;
      }
      if (res.status >= 200 && res.status < 300) {
        const granted = Number(param(header(res, "contact"), "expires")) || Number(header(res, "expires")) || expires;
        this.registered = true;
        this.emit("registered", { expires: granted });
        clearTimeout(this.registerTimer);
        this.registerTimer = setTimeout(() => this.register(expires).catch((err) => this.emit("error", err)), Math.max(30, granted * 0.8) * 1000);
        this.registerTimer.unref?.();
        return res;
      }
      this.registered = false;
      throw new Error(`Registration failed: ${res.status} ${res.reason || ""}`.trim());
    }
    throw new Error("Registration failed: authentication rejected");
  }

  // ---------------- Outbound calls ----------------
  /** Place a call through the trunk. Resolves to a Leg once answered; rejects with {status} otherwise. */
  async invite({ to, from, dest = this.trunkDest(), domain = this.domain, onRinging, onLeg, headers: extra = [] }) {
    const socket = await bindRtpSocket(this.opts.rtp);
    const rtp = new RtpSession(socket);
    const leg = new Leg(this, { direction: "outbound", callId: newCallId(), dest, rtp });
    this.calls.set(leg.callId, leg);
    onLeg?.(leg);
    const uri = `sip:${to}@${domain}`;
    leg.localTag = newTag();
    leg.localUri = `<sip:${from}@${domain}>`;
    leg.remoteUri = `<sip:${to}@${domain}>`;
    leg.remoteTarget = uri;
    const sdp = buildSdp({ ip: this.ip, port: rtp.port });
    let auth = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      leg.cseq++;
      const b = branch();
      const text = build({
        method: "INVITE", uri,
        headers: [["Via", this.via(b)], ["Max-Forwards", "70"], ["From", `${leg.localUri};tag=${leg.localTag}`], ["To", leg.remoteUri],
          ["Call-ID", leg.callId], ["CSeq", `${leg.cseq} INVITE`], ["Contact", `<sip:${from}@${this.ip}:${this.port}>`],
          ["Allow", ALLOW], ["User-Agent", "VoiceDesk"], ["Content-Type", "application/sdp"], ...extra,
          ...(auth ? [[auth.header, auth.value]] : [])],
        body: sdp,
      });
      leg.pending = { b, cseq: leg.cseq, uri, text };
      const res = await this.transaction({ text, b, method: "INVITE", dest, onProvisional: (m) => m.status === 180 || m.status === 183 ? onRinging?.(m) : null });
      leg.pending = null;
      if (res.status >= 300) this.ackFailure(leg, res, b, uri);
      if ((res.status === 401 || res.status === 407) && attempt < 2 && this.trunk.password) {
        const challengeHeader = res.status === 401 ? "www-authenticate" : "proxy-authenticate";
        auth = { header: res.status === 401 ? "Authorization" : "Proxy-Authorization", value: digest({ challenge: header(res, challengeHeader), method: "INVITE", uri, username: this.trunk.authUser || this.trunk.username, password: this.trunk.password }) };
        continue;
      }
      if (res.status >= 200 && res.status < 300) {
        leg.remoteTag = param(header(res, "to"), "tag");
        leg.remoteUri = header(res, "to");
        leg.remoteTarget = uriOf(header(res, "contact")) || uri;
        leg.routeSet = headers(res, "record-route").reverse();
        const answer = parseSdp(res.body);
        const pt = chooseCodec(answer) ?? 0;
        if (answer) rtp.setRemote(answer.ip, answer.port, pt);
        if (answer?.dtmf != null) rtp.dtmfType = answer.dtmf;
        leg.sendAck(leg.cseq);
        leg.state = "confirmed";
        rtp.start();
        return leg;
      }
      leg.end("failed");
      const err = new Error(`Call failed: ${res.status} ${res.reason || ""}`.trim());
      err.status = res.status;
      throw err;
    }
    leg.end("failed");
    const err = new Error("Call failed: authentication rejected");
    err.status = 403;
    throw err;
  }

  /** ACK for a non-2xx final response (same branch as the INVITE, RFC 3261 §17.1.1.3). */
  ackFailure(leg, res, b, uri) {
    const text = build({
      method: "ACK", uri,
      headers: [["Via", this.via(b)], ["Max-Forwards", "70"], ["From", `${leg.localUri};tag=${leg.localTag}`], ["To", header(res, "to")],
        ["Call-ID", leg.callId], ["CSeq", `${leg.cseq} ACK`]],
    });
    this.sendRaw(text, leg.dest.port, leg.dest.address);
  }
}

/** One call leg (inbound or outbound) with its dialog state and RTP session. */
export class Leg extends EventEmitter {
  constructor(ua, { direction, callId, invite = null, dest, rtp = null }) {
    super();
    this.ua = ua;
    this.direction = direction;
    this.callId = callId;
    this.invite = invite;
    this.dest = dest;
    this.rtp = rtp;
    this.cseq = 0;
    this.state = "early";
    this.routeSet = [];
    if (invite) {
      const from = header(invite, "from");
      const to = header(invite, "to");
      this.remoteTag = param(from, "tag");
      this.remoteUri = from;
      this.localUri = to.replace(/;\s*tag=[^;]+/i, "");
      this.localTag = newTag();
      this.remoteTarget = uriOf(header(invite, "contact")) || uriOf(from);
      this.routeSet = headers(invite, "record-route");
      this.fromUser = parseUri(uriOf(from))?.user || "";
      this.toUser = parseUri(invite.uri)?.user || parseUri(uriOf(to))?.user || "";
      this.offer = parseSdp(invite.body);
      this.cseq = 0;
    }
  }

  // ---- Inbound: ring, answer, reject ----
  respond(status, opts = {}) {
    const text = response(this.invite, status, { toTag: this.localTag, ...opts });
    this.ua.serverTx.set(param(header(this.invite, "via"), "branch"), text);
    this.ua.sendRaw(text, this.dest.port, this.dest.address);
    return text;
  }

  ringing() {
    if (this.state === "early") this.respond(180);
  }

  reject(status = 486) {
    if (this.state !== "early") return;
    this.respond(status);
    this.end("rejected");
  }

  /** Answer with 200 OK (+SDP); resolves once the caller ACKs (or after 32 s of retransmission). */
  async answer() {
    if (this.state !== "early") throw new Error("Call is no longer ringing");
    const pt = chooseCodec(this.offer);
    if (pt == null) {
      this.reject(488);
      throw new Error("No common codec (need PCMU or PCMA)");
    }
    const socket = await bindRtpSocket(this.ua.opts.rtp);
    this.rtp = new RtpSession(socket, { payloadType: pt, dtmfType: this.offer.dtmf ?? 101 });
    this.rtp.setRemote(this.offer.ip, this.offer.port, pt);
    const sdp = buildSdp({ ip: this.ua.ip, port: this.rtp.port, payloadTypes: [pt] });
    this.answerSdp = sdp;
    const text = this.respond(200, { extra: [["Contact", this.ua.contact], ["Allow", ALLOW], ["Content-Type", "application/sdp"]], body: sdp });
    this.state = "answered";
    this.rtp.start();
    return new Promise((resolve) => {
      let interval = T1;
      const started = Date.now();
      this.acked = () => { clearTimeout(this.retx); resolve(this); };
      const again = () => {
        if (this.state !== "answered") return;
        if (Date.now() - started > 64 * T1) {
          this.bye(); // never ACKed: give up
          return resolve(this);
        }
        this.ua.sendRaw(text, this.dest.port, this.dest.address);
        interval = Math.min(interval * 2, T2);
        this.retx = setTimeout(again, interval);
        this.retx.unref?.();
      };
      this.retx = setTimeout(again, interval);
      this.retx.unref?.();
    });
  }

  onAck() {
    if (this.state === "answered") {
      this.state = "confirmed";
      this.acked?.();
      this.emit("confirmed");
    }
  }

  onCancel() {
    if (this.state === "early") {
      this.respond(487);
      this.end("cancelled");
    }
  }

  onReinvite(msg, rinfo) {
    // Hold / session refresh: keep the same media, answer with our SDP.
    const offer = parseSdp(msg.body);
    if (offer && this.rtp && offer.ip !== "0.0.0.0") this.rtp.setRemote(offer.ip, offer.port);
    const text = response(msg, 200, { toTag: this.localTag, extra: [["Contact", this.ua.contact], ["Content-Type", "application/sdp"]], body: this.answerSdp || buildSdp({ ip: this.ua.ip, port: this.rtp?.port || 0 }) });
    this.ua.sendRaw(text, rinfo.port, rinfo.address);
  }

  // ---- In-dialog requests ----
  dialogHeaders(method, cseq, b) {
    return [
      ["Via", this.ua.via(b)], ["Max-Forwards", "70"],
      ["From", `${this.localUri};tag=${this.localTag}`],
      ["To", `${this.remoteUri.replace(/;\s*tag=[^;]+/i, "")}${this.remoteTag ? `;tag=${this.remoteTag}` : ""}`],
      ["Call-ID", this.callId], ["CSeq", `${cseq} ${method}`],
      ...this.routeSet.map((r) => ["Route", r]),
    ];
  }

  sendAck(cseq) {
    const text = build({ method: "ACK", uri: this.remoteTarget, headers: [...this.dialogHeaders("ACK", cseq, branch()), ["Contact", this.ua.contact]] });
    this.lastAck = text;
    this.ua.sendRaw(text, this.dest.port, this.dest.address);
  }

  /** Hang up: BYE when connected, CANCEL while our outbound call is still ringing. */
  async bye() {
    if (this.state === "ended") return;
    if (this.direction === "outbound" && this.pending) {
      const { b, cseq, uri } = this.pending;
      const text = build({ method: "CANCEL", uri, headers: [["Via", this.ua.via(b)], ["Max-Forwards", "70"], ["From", `${this.localUri};tag=${this.localTag}`], ["To", this.remoteUri], ["Call-ID", this.callId], ["CSeq", `${cseq} CANCEL`]] });
      this.ua.sendRaw(text, this.dest.port, this.dest.address);
      return this.end("local-cancel");
    }
    if (this.state === "early") return this.reject(480);
    clearTimeout(this.retx);
    this.cseq += 1;
    const b = branch();
    const text = build({ method: "BYE", uri: this.remoteTarget, headers: [...this.dialogHeaders("BYE", this.cseq, b), ["User-Agent", "VoiceDesk"]] });
    this.end("local-bye");
    await this.ua.transaction({ text, b, method: "BYE", dest: this.dest });
  }

  end(reason) {
    if (this.state === "ended") return;
    this.state = "ended";
    clearTimeout(this.retx);
    this.rtp?.close();
    this.ua.calls.delete(this.callId);
    this.emit("end", reason);
  }
}
