// Entry point: serves the website, the dashboard, the API and the phone webhooks.
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Store } from "./db.js";
import { aiEnabled } from "./llm.js";
import { startScheduler } from "./scheduler.js";
import { attachRealtime } from "./realtime.js";
import { apiRouter } from "./routes/api.js";
import { twilioRouter } from "./routes/twilio.js";
import { handleIncoming } from "./channels.js";
import { metaRouter } from "./meta.js";
import { cachedAudio } from "./tts.js";
import { voiceRouter } from "./voice/router.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();
  app.disable("x-powered-by");
  // Behind a load balancer / reverse proxy, set TRUST_PROXY=1 so rate limits see real client IPs.
  if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    // The widget script is embedded on other sites; everything else must not be framed.
    if (!req.path.startsWith("/widget")) res.set("X-Frame-Options", "DENY");
    next();
  });
  app.use("/api", express.json({ limit: "200kb" }), apiRouter(db));
  app.use("/twilio", twilioRouter(db));
  app.use("/voice", voiceRouter(db));
  app.use("/meta", metaRouter(db, handleIncoming));
  app.get("/healthz", (req, res) => res.json({ ok: true }));
  // Premium-voice audio that Twilio fetches with <Play> (see tts.js).
  app.get("/audio/:id.mp3", (req, res) => {
    const clip = /^[a-f0-9]{32}$/.test(req.params.id) && cachedAudio(req.params.id);
    if (!clip) return res.sendStatus(404);
    res.type(clip.type).set("Cache-Control", "public, max-age=3600").send(clip.audio);
  });
  app.use(express.static(path.join(here, "..", "public"), { extensions: ["html"] }));
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = new Store(process.env.DATA_FILE || path.join(here, "..", "data", "db.json"));
  const port = Number(process.env.PORT) || 3000;
  startScheduler(db);
  const server = createApp(db).listen(port, () => {
    console.log(`VoiceDesk running at http://localhost:${port}`);
    console.log(aiEnabled() ? "AI: Claude is on." : "AI: demo mode (set ANTHROPIC_API_KEY to turn on real answers).");
  });
  attachRealtime(server, db);
}
