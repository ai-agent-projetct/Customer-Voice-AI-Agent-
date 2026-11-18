// SDP (RFC 4566): the small text block inside INVITE / 200 OK that says
// where to send audio (IP and port) and which codecs each side accepts.
// VoiceDesk offers G.711 μ-law (0), A-law (8) and keypad events (101).

export function buildSdp({ ip, port, payloadTypes = [0, 8], dtmf = 101, sessionId = Date.now() }) {
  const names = { 0: "PCMU/8000", 8: "PCMA/8000" };
  return [
    "v=0",
    `o=VoiceDesk ${sessionId} ${sessionId} IN IP4 ${ip}`,
    "s=VoiceDesk",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    `m=audio ${port} RTP/AVP ${[...payloadTypes, dtmf].join(" ")}`,
    ...payloadTypes.map((pt) => `a=rtpmap:${pt} ${names[pt]}`),
    `a=rtpmap:${dtmf} telephone-event/8000`,
    `a=fmtp:${dtmf} 0-16`,
    "a=ptime:20",
    "a=sendrecv",
    "",
  ].join("\r\n");
}

/** → { ip, port, payloadTypes[], dtmf } for the first audio stream, or null. */
export function parseSdp(text) {
  const lines = String(text || "").split(/\r?\n/);
  let sessionIp = null, mediaIp = null, port = null, payloadTypes = [], dtmf = null, inAudio = false;
  for (const line of lines) {
    if (line.startsWith("c=")) {
      const ip = line.split(/\s+/)[2];
      if (inAudio) mediaIp = ip;
      else sessionIp = ip;
    } else if (line.startsWith("m=")) {
      if (port != null) break; // only the first audio stream
      const parts = line.slice(2).split(/\s+/);
      inAudio = parts[0] === "audio";
      if (inAudio) {
        port = Number(parts[1]);
        payloadTypes = parts.slice(3).map(Number);
      }
    } else if (inAudio && /^a=rtpmap:(\d+)\s+telephone-event/i.test(line)) {
      dtmf = Number(/^a=rtpmap:(\d+)/.exec(line)[1]);
    }
  }
  if (port == null) return null;
  return { ip: mediaIp || sessionIp, port, payloadTypes, dtmf };
}

/** Pick the codec: the first one in the caller's order that we support. */
export function chooseCodec(offer) {
  return offer?.payloadTypes.find((pt) => pt === 0 || pt === 8) ?? null;
}
