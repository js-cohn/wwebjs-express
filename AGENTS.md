# Project: wwebjs-express

## Agent Protocol
**All AI agents MUST read this file at the start of a session.** Before concluding a significant task (bug fix, feature addition, architectural change), agents MUST update the "Recent Context & Status" and "Critical Implementation Details" sections to ensure continuity and prevent regression.

## Overview
`wwebjs-express` is a specialized WhatsApp-to-Webhook gateway. It provides an Express-based REST API to control WhatsApp sessions, send text/media messages, and forward incoming WhatsApp events (messages, reactions, session state) to a configured webhook.

**Project Philosophy:**
- **Nimble:** Minimal dependencies, lightweight runtime, and focused functionality.
- **Set-and-Forget:** Highly resilient, self-healing (via robust watchdogs and lock cleanup), and designed for autonomous long-term operation on small VMs without manual intervention.

## Technical Architecture
- **Runtime:** Node.js (v22+ recommended).
- **Core Library:** `whatsapp-web.js` (using Puppeteer for browser automation).
- **Processing:** `ffmpeg` for media conversion and `whisper.cpp` (via `whisper-node`) for on-device audio transcription.
- **Persistence:** Docker volumes mount `./sessions` and `./files` to maintain authentication state and media across restarts.
- **Deployment:** Containerized via Docker, intended to sit behind a reverse proxy (e.g., Caddy).

## Critical Implementation Details
- **Session Lifecycle:** Managed in `wwebjs-express/whatsapp.js`.
- **Defense-in-depth Auth (August 2026):** `/send-*` endpoints now enforce `X-API-Key` inside Express in addition to Caddy. `/web-*` endpoints support optional Express Basic Auth when `BASIC_AUTH_PASS` is set; otherwise Caddy remains the primary Basic Auth layer.
- **Input Validation (August 2026):** Session IDs are restricted to short safe slugs. `messageRe` reply IDs are shape-validated before use.
- **Reply Safety (August 2026):** Reply IDs are intended to be exact webhook `messageId` values for the same session/chat. Send logic rejects `messageRe` values that do not match the destination candidate.
- **Webhook Identity Model (August 2026):** Message and reaction webhooks include explicit WhatsApp identity fields (`fromType`, `resolvedFrom`, `resolvedFromType`, `contact.id`, `contact.idType`) so downstream systems do not assume every numeric-looking ID is a phone number.
- **Stability Fixes (Applied June 2026):**
  - **Robust Watchdog:** A recurring watchdog with a 5-minute strict timeout for the `READY` event to prevent "zombie" authenticated-but-connected sessions.
  - **Web Version Locking:** Uses `webVersionCache` with a remote path to a known-stable WhatsApp Web version (`2.2412.54`).
  - **Docker Stability:** Puppeteer launched with `--disable-site-isolation-trials` and `--no-zygote` to prevent storage persistence hangs.
  - **Enhanced Webhook Diagnostics:** `postWebhook` now logs explicit success (HTTP status) and detailed failure reasons (status codes + response body) to help diagnose silent delivery failures.
  - **LID Phone Number Fix (Improved June 10, 2026):** Simplified `getContactPhoneNumber` to use an early-return pattern. It first checks if the contact ID is already resolved to a phone number (`@c.us`). If not, it explicitly skips the numeric parts of known LIDs (from `fromId` and `contact.id`) while checking `contact.number`, `contact.phoneNumber`, and `getFormattedNumber()`. This is more robust and direct than previous iterations.

- **Media Handling:** Incoming `ptt` (voice notes) and `audio` are automatically transcribed using Whisper.cpp before being forwarded to the webhook.

## API Endpoints
- `GET /healthz`: Health check.
- `GET /web-start/:id`: Initializes/Resumes a session.
- `GET /web-pause/:id`: Stops a session (persists auth).
- `GET /web-image/:id`: Returns a QR code for scanning or a live screenshot of the browser.
- `GET /web-stats`: Returns the current state of all active sessions.
- `POST /send-text`: Sends a text message (supports quoting).
- `POST /send-file`: Downloads a file from a URL and sends it as a WhatsApp document.

## Recent Context & Status (August 5, 2026)
- **In progress:** Hardening branch `hardening-auth-lid-replies` adds Express-level auth, stricter input validation, explicit LID/contact identity fields, and reply safety checks.
- **Operational Context:** Current ATC deployment correctly runs behind Caddy with Caddy environment loading verified and Docker binding Express to `127.0.0.1:3001`, so direct public bypass risk is low.
- **Compatibility:** Existing webhook fields (`from`, `notifyName`, `phoneNumber`, `messageId`) remain for backward compatibility. New identity fields are additive.

## Future Goals / Roadmap
- Add automated tests for auth middleware, session ID validation, reply ID validation, and destination/reply matching.
- Consider a server-side reply token store so callers can send a stable `replyToken` instead of raw WhatsApp message IDs.
- Monitor for `aquire-persistent-storage-denied` errors to further refine Puppeteer arguments.
- Enhance webhook retry logic if the endpoint is temporarily unavailable.
- Explore alternative `webVersionCache` strategies if WhatsApp Web updates break the current pinned version.
