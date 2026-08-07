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
- **Stability Fixes (Applied June 2026):**
  - **Robust Watchdog:** A recurring watchdog with a 5-minute strict timeout for the `READY` event to prevent "zombie" authenticated-but-connected sessions.
  - **Web Version Locking:** Uses `webVersionCache` with a remote path to a known-stable WhatsApp Web version (`2.2412.54`).
  - **Docker Stability:** Puppeteer launched with `--disable-site-isolation-trials` and `--no-zygote` to prevent storage persistence hangs.
  - **Enhanced Webhook Diagnostics:** `postWebhook` now logs explicit success (HTTP status) and detailed failure reasons (status codes + response body) to help diagnose silent delivery failures.
  - **LID Phone Number Fix (Improved June 10, 2026):** Simplified `getContactPhoneNumber` to use an early-return pattern. It first checks if the contact ID is already resolved to a phone number (`@c.us`). If not, it explicitly skips the numeric parts of known LIDs (from `fromId` and `contact.id`) while checking `contact.number`, `contact.phoneNumber`, and `getFormattedNumber()`. This is more robust and direct than previous iterations.

- **Media Handling:** Incoming `ptt` (voice notes) and `audio` are automatically transcribed using Whisper.cpp before being forwarded to the webhook.
- **Quoted Messages Resolution (August 2026):** Webhook payloads for incoming messages resolve quoted message references (via `msg.getQuotedMessage()` and fallback checking `msg._data.quotedMsg.id._serialized`) and append them as `messageRe`.
- **Docker Compose Volumes (August 2026):** Mismatched service names in the override file were corrected, and JS source files were bind-mounted inside the main `docker-compose.yml` to ensure local code execution.

## API Endpoints
- `GET /web-start/:id`: Initializes/Resumes a session.
- `GET /web-pause/:id`: Stops a session (persists auth).
- `GET /web-image/:id`: Returns a QR code for scanning or a live screenshot of the browser.
- `GET /web-stats`: Returns the current state of all active sessions.
- `POST /send-text`: Sends a text message (supports quoting).
- `POST /send-file`: Downloads a file from a URL and sends it as a WhatsApp document.

## Recent Context & Status (August 7, 2026)
- **Resolved:** Mismatched service name in `docker-compose.override.yml` (`wwebjs-api` -> `wwebjs-express`) which was preventing local source bind-mounts.
- **Feature Implemented:** Support for forwarding incoming reply/quote message IDs to the webhook.
- **Current State:** The system is fully stable. The `atc2606` session is authenticated, connected, and active. Webhook notifications are successfully delivered to Webhook.site as verified by log checks.
- **Agent Protocol Active:** This file was updated following the compose fix and quote resolution implementation.

## Future Goals / Roadmap
- Monitor for `aquire-persistent-storage-denied` errors to further refine Puppeteer arguments.
- Enhance webhook retry logic if the endpoint is temporarily unavailable.
- Explore alternative `webVersionCache` strategies if WhatsApp Web updates break the current pinned version.
