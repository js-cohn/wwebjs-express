# wwebjs-express

Lightweight Express API for `whatsapp-web.js`, designed to run behind Caddy.

## Prerequisites

- Docker + Docker Compose
- Caddy with `caddy-ratelimit`

Build Caddy with:
```bash
xcaddy build --with https://github.com/mholt/caddy-ratelimit
```

## Setup

1. Create `.env` from the template:
```bash
cp .env.example .env
```

2. Generate credentials:
```bash
# API key
openssl rand -hex 32

# Basic auth hash for Caddy
caddy hash-password --plaintext 'your_password'
# or: docker run --rm caddy:2 caddy hash-password --plaintext 'your_password'
```

3. Fill `.env` values.
If using Caddy placeholders in `Caddyfile`, set at least:
- `DOMAIN`
- `PORT`
- `API_KEY`
- `BASIC_AUTH_USER`
- `BASIC_AUTH_HASH`

4. Start the API container:
```bash
docker compose up -d --build
```

5. Start or reload Caddy:
```bash
caddy run --config /home/you/wwebjs-express/Caddyfile --adapter caddyfile
caddy reload --config /home/you/wwebjs-express/Caddyfile --adapter caddyfile
```

## Usage

1. Start a session:
```bash
curl -u $BASIC_AUTH_USER:<your_plaintext_password> \
  https://$DOMAIN/web-start/<session_id>
```

2. Open QR/live page for pairing/status (`/web-image`):
```bash
curl -u $BASIC_AUTH_USER:<your_plaintext_password> \
  https://$DOMAIN/web-image/<session_id>
```

3. Check active session states:
```bash
curl -u $BASIC_AUTH_USER:<your_plaintext_password> \
  https://$DOMAIN/web-stats
```

4. Stop a session:
```bash
curl -u $BASIC_AUTH_USER:<your_plaintext_password> \
  https://$DOMAIN/web-stop/<session_id>
```

5. Send text:
```bash
curl -X POST https://$DOMAIN/send-text \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"session":"<session_id>","to":"13001234567","text":"Hello"}'
```

6. Send file:
```bash
curl -X POST https://$DOMAIN/send-file \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"session":"<session_id>","to":"13001234567","url":"https://example.com/file.pdf","filename":"file.pdf"}'
```

## Endpoint Summary

| Endpoint | Method | Auth |
|---|---|---|
| `/web-start/:id` | `GET` | Basic Auth |
| `/web-stop/:id` | `GET` | Basic Auth |
| `/web-image/:id` | `GET` | Basic Auth |
| `/web-stats` | `GET` | Basic Auth |
| `/send-text` | `POST` | `X-API-Key` |
| `/send-file` | `POST` | `X-API-Key` |
| `/files/*` | `GET`,`HEAD` | Public |

## Webhook Events

- Incoming WhatsApp messages are sent to `WEBHOOK_URL` with `event: "message"`.
- Incoming message reactions are also sent as `event: "message"` with `type: "reaction"`.
- Message/reaction payloads include `notifyName` as best-effort via contact lookup when available; it may still be `null`.
- Message/reaction payloads include `phoneNumber` as best-effort (from `client.getContactById` and ID parsing); it may be `null`, especially for some `@lid` contacts.
- For incoming media messages, `media.url` is absolute when `DOMAIN` is a valid public host; otherwise it is relative (`/files/...`).
- Incoming `audio`/`ptt` messages are transcribed with whisper.cpp (`WHISPER_MODEL`, default `tiny`, timeout via `WHISPER_TIMEOUT_SECONDS`). If no speech is detected, body is `[Inaudible Audio]`; if transcription fails, body is `[Transcription Failed]`.
- Session lifecycle events use `event: "session"` with `type`: `authenticated`, `ready` (`state: "READY"`), `state_change` (`state`), `auth_failure` (`error`), and `disconnected` (`reason`).

## Import Into Parent Stack (Advanced)

Docker Compose:
```bash
WWEBJS_ROOT=/home/you/wwebjs-express \
docker compose \
  -f /path/to/parent/docker-compose.yml \
  -f /home/you/wwebjs-express/docker-compose.yml \
  up -d
```

Optional compose overrides:
- `WWEBJS_ROOT` path to this repo
- `WWEBJS_CONTAINER_NAME` default `wwebjs-express`
- `WWEBJS_BIND_IP` default `127.0.0.1`

Caddy (top-level import):
```caddyfile
import /home/you/wwebjs-express/Caddyfile
```

Important:
- `{$...}` placeholders in `Caddyfile` are read from the Caddy process environment.
- `.env` used by Docker Compose is not automatically loaded by host/systemd Caddy.
- If env vars are not loaded into Caddy, either load them in the Caddy service environment or replace placeholders with literal values.

If Caddy runs in Docker on the same network, set:
```env
WWEBJS_UPSTREAM_HOST=wwebjs-api
```

## Notes

- API binds to `127.0.0.1` by default in Compose.
- Persisted data lives in `sessions/` and `files/`.
- Keep origin restricted (especially when using Cloudflare) so only expected clients can reach Caddy.
- For accurate per-user rate limits behind Cloudflare, configure trusted proxies in your parent/global Caddy config so `{client_ip}` resolves to the real client IP.
- If logs show `Whisper model not found`, run:
  - `docker exec -it wwebjs-express bash -lc "cd /app/node_modules/whisper-node/lib/whisper.cpp/models && ./download-ggml-model.sh tiny && ls -lh ggml-tiny.bin"`
