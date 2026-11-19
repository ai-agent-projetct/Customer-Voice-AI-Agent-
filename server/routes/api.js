// The JSON API: mounts each area of the product.
import express from "express";
import { requireAuth } from "../auth.js";
import { accountRouter } from "./account.js";
import { adminRouter } from "./admin.js";
import { agentsRouter } from "./agents.js";
import { developerRouter } from "./developer.js";
import { growthRouter } from "./growth.js";
import { v1Router } from "./v1.js";
import { workspaceRouter } from "./workspace.js";
import { publicRouter } from "./public.js";
import { recordsRouter } from "./records.js";
import { voiceRouter } from "./voice.js";
import { voicePlatformRouter } from "./voice-platform.js";

export function apiRouter(db) {
  const r = express.Router();
  const auth = requireAuth(db);
  r.use("/public", publicRouter(db));
  r.use("/v1", v1Router(db));
  r.use("/developer", developerRouter(db, auth));
  r.use("/admin", adminRouter(db, auth));
  r.use("/agents", agentsRouter(db, auth));
  r.use(accountRouter(db, auth));
  r.use(recordsRouter(db, auth));
  r.use(growthRouter(db, auth));
  r.use(workspaceRouter(db, auth));
  r.use(voiceRouter(db, auth));
  r.use(voicePlatformRouter(db, auth));
  r.use((req, res) => res.status(404).json({ error: "Not found." }));
  return r;
}
