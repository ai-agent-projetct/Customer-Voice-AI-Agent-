# VoiceDesk: website, dashboard, APIs, AI voice pipeline and VoiceDesk Network (SIP/RTP).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs
# Database file and call recordings live here: mount a volume so they survive restarts.
VOLUME ["/app/data"]
ENV DATA_FILE=/app/data/db.json RECORDINGS_DIR=/app/data/recordings PORT=3000
USER node
EXPOSE 3000 5060/udp
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
