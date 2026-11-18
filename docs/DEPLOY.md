# Putting VoiceDesk online (with your own phone network)

VoiceDesk Network needs a server with a **public, fixed IP address**, because the operator sends
calls (SIP over UDP) and call audio (RTP over UDP) straight to it. Website-style hosts
(Render, Railway, Vercel) can't receive UDP calls, so use a small virtual server (VPS).

## 1. Get a server in India

Any provider with a Mumbai, Chennai, Hyderabad or Bangalore region works. Indian providers
include E2E Networks, Yotta and NxtGen; global ones include AWS (Mumbai, Hyderabad), Google Cloud
(Mumbai, Delhi), Azure (Pune, Chennai) and DigitalOcean (Bangalore).

- Size to start: 2 vCPU, 4 GB RAM, Ubuntu 24.04, a **static public IP**.
- Firewall (security group):
  - TCP 80 and 443 (website, dashboard, API) from anywhere
  - UDP 5060 (SIP) **only from your operator's IP addresses**
  - UDP 10000–20000 (call audio) from anywhere
  - TCP 22 (SSH) only from your own IP

## 2. Install and start

```bash
# On the server
curl -fsSL https://get.docker.com | sh
git clone https://github.com/ai-agent-projetct/Customer-Voice-AI-Agent-.git voicedesk
cd voicedesk
cp .env.example .env
nano .env        # fill in the values below
docker compose up -d --build
docker compose logs -f   # look for "VoiceDesk running" and "SIP: VoiceDesk Network listening"
```

The database and call recordings are kept in the `voicedesk-data` Docker volume. Back it up
daily (for example `docker run --rm -v voicedesk-data:/d -v $PWD:/b alpine tar czf /b/backup.tgz /d`).

## 3. The important `.env` values

| Setting | Example |
|---|---|
| `PUBLIC_URL` | `https://app.yourcompany.in` |
| `ANTHROPIC_API_KEY` | from console.anthropic.com |
| `SARVAM_API_KEY` (and/or `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`) | voice engine keys |
| `SIP_ENABLED` | `1` |
| `SIP_PUBLIC_IP` | the server's static IP |
| `SIP_TRUNK_HOST`, `SIP_TRUNK_PORT`, `SIP_TRUNK_USER`, `SIP_TRUNK_PASS`, `SIP_TRUNK_REGISTER` | from your operator |
| `SIP_ALLOWED_IPS` | your operator's signalling IPs |
| `SIP_DIAL_FORMAT` | what your operator expects: `e164`, `plain` or `national` |
| `ADMIN_EMAILS` | your email, to see the admin console |

## 4. HTTPS

Put Caddy in front for automatic certificates (it listens on 80/443 and forwards to 3000):

```bash
sudo apt install -y caddy
echo 'app.yourcompany.in {
  reverse_proxy 127.0.0.1:3000
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Point your domain's DNS A record to the server's IP first.

## 5. First real call

1. Admin console → **VoiceDesk Network numbers** → give a number (DID from your operator) to a business.
2. Call that number from your mobile. With `SIP_DEBUG=1` the logs show every SIP message,
   which helps if the operator's format differs.
3. Make a test call out: Dashboard → Phone & voice → **Ring my phone**.

## What was checked before shipping

- The app runs inside the official `node:22-slim` image with host networking, answers on HTTP,
  and the SIP engine answers `OPTIONS` with `200 OK` (checked in the build environment).
- `npm ci` inside `docker build` couldn't be checked there (that environment's network blocks
  the npm registry from inside Docker). On a normal server it downloads the 3 dependencies.
