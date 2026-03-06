# wwebjs-express

Express API for `whatsapp-web.js`, intended to run behind Caddy.

## Prerequisites

- Docker + Docker Compose
- Caddy with `caddy-ratelimit`

Build Caddy with:

```bash
xcaddy build --with github.com/mholt/caddy-ratelimit
```

## Setup

1. Create your env file:

```bash
cp .env.example .env
```

2. Generate secrets:

```bash
# API key (for /send-* endpoints)
openssl rand -hex 32

# Basic auth hash (for /web-* endpoints)
caddy hash-password --plaintext 'your_password'
# or: docker run --rm caddy:2 caddy hash-password --plaintext 'your_password'
```

3. Update `.env`.

Minimum values you should set:

- `DOMAIN`
- `PORT`
- `WEBHOOK_URL`
- `API_KEY`
- `BASIC_AUTH_USER`
- `BASIC_AUTH_HASH`
- `WHISPER_MODEL` (optional, defaults to `base`)

4. Build/start the API:

```bash
docker compose up -d --build
```

5. Load Caddy config:

- Direct use:

```bash
caddy validate --config /absolute/path/to/Caddyfile --adapter caddyfile
caddy reload --config /absolute/path/to/Caddyfile --adapter caddyfile
```

- Imported into a parent Caddyfile:

```caddyfile
import /absolute/path/to/wwebjs-express/Caddyfile
```

Notes about env/import behavior are kept in comments inside `Caddyfile` and `docker-compose.yml`.

## Usage

Set local shell vars used in examples:

```bash
export DOMAIN='domain.example.com'
export BASIC_AUTH_USER='user'
export BASIC_AUTH_PASS='pass'
export API_KEY='your_api_key'
export SESSION='your_session_name'
```

1. Start a WhatsApp session:

```bash
curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
  "https://$DOMAIN/web-start/$SESSION"
```

2. Get QR (not paired yet) or live WhatsApp screenshot (already paired):

```bash
curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
  "https://$DOMAIN/web-image/$SESSION"
```

3. Check session state(s):

```bash
curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
  "https://$DOMAIN/web-stats"
```

4. Send text (`text` is required):

```bash
curl -X POST "https://$DOMAIN/send-text" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"session":"'"$SESSION"'","to":"15551234567","text":"Hello from API"}'
```

5. Send file by URL:

```bash
curl -X POST "https://$DOMAIN/send-file" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"session":"'"$SESSION"'","to":"15551234567","url":"https://example.com/file.pdf","filename":"file.pdf","caption":"Optional caption"}'
```

6. Stop a session:

```bash
curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
  "https://$DOMAIN/web-stop/$SESSION"
```

7. Access saved media file (public endpoint):

```bash
curl -I "https://$DOMAIN/files/<filename_from_webhook_or_send_file_response>"
```

### Endpoint Reference

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/web-start/:id` | `GET` | Basic Auth | Start/init session |
| `/web-stop/:id` | `GET` | Basic Auth | Stop client (keeps auth) |
| `/web-image/:id` | `GET` | Basic Auth | QR or live screenshot |
| `/web-stats` | `GET` | Basic Auth | Session states |
| `/send-text` | `POST` | `X-API-Key` | Send text message |
| `/send-file` | `POST` | `X-API-Key` | Download + send file |
| `/files/*` | `GET`,`HEAD` | Public | Retrieve saved media |

## Webhook Events

Incoming events are POSTed to `WEBHOOK_URL`.

### 1) Incoming message (`event: "message"`)

```json
{
  "event": "message",
  "session": "your_session_name",
  "from": "15551234567@c.us",
  "body": "Hello",
  "type": "chat",
  "notifyName": "John",
  "phoneNumber": "15551234567"
}
```

### 2) Incoming media message

```json
{
  "event": "message",
  "session": "your_session_name",
  "from": "15551234567@c.us",
  "body": "filename.pdf",
  "type": "document",
  "notifyName": "John",
  "phoneNumber": "15551234567",
  "media": {
    "url": "https://domain.example.com/files/1772577946996_filename.pdf",
    "mimetype": "application/pdf",
    "filename": "filename.pdf"
  }
}
```

### 3) Incoming reaction (sent as message event)

```json
{
  "event": "message",
  "session": "your_session_name",
  "from": "15551234567@c.us",
  "body": "👍",
  "type": "reaction",
  "notifyName": "John",
  "phoneNumber": "15551234567"
}
```

### 4) Session lifecycle (`event: "session"`)

```json
{
  "event": "session",
  "session": "your_session_name",
  "type": "ready",
  "state": "READY"
}
```

Session `type` values:

- `authenticated`
- `ready`
- `state_change`
- `auth_failure`
- `disconnected`

Additional webhook behavior:

- `notifyName` and `phoneNumber` are best-effort and may be `null`.
- Reactions are de-duplicated before webhook delivery.
- `audio` / `ptt` messages use whisper.cpp transcription; no speech becomes `[Inaudible Audio]`.
- If transcription fails for `audio` / `ptt`, `body` becomes `[Transcription Failed]`.
- Session payload details: `state_change` includes `state`, `auth_failure` includes `error`, and `disconnected` includes `reason`.
- If `DOMAIN` is invalid/unset, media URLs fall back to relative paths (`/files/...`).

## Data Persistence

- `sessions/` stores WhatsApp auth/session data.
- `files/` stores downloaded/saved media files.
