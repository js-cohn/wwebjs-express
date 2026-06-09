# Project: wwebjs-express

## Overview
`wwebjs-express` is a specialized WhatsApp-to-Webhook gateway. It provides an Express-based REST API to control WhatsApp sessions, send text/media messages, and forward incoming WhatsApp events (messages, reactions, session state) to a configured webhook.

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
  - **LID Phone Number Fix:** Fixed logic that incorrectly reported the numeric part of a WhatsApp LID as a `phoneNumber`. The system now correctly distinguishes between real phone numbers and internal LIDs.

- **Media Handling:** Incoming `ptt` (voice notes) and `audio` are automatically transcribed using Whisper.cpp before being forwarded to the webhook.

## API Endpoints
- `GET /web-start/:id`: Initializes/Resumes a session.
- `GET /web-pause/:id`: Stops a session (persists auth).
- `GET /web-image/:id`: Returns a QR code for scanning or a live screenshot of the browser.
- `GET /web-stats`: Returns the current state of all active sessions.
- `POST /send-text`: Sends a text message (supports quoting).
- `POST /send-file`: Downloads a file from a URL and sends it as a WhatsApp document.

## Recent Context & Status (June 9, 2026)
- **Resolved:** A bug where a session hung at "Authenticated" due to storage errors was fixed by improving the watchdog and Puppeteer arguments.
- **Current State:** The system is stable. Sessions are persisted via Docker volumes. The watchdog successfully cleans up failed handshake attempts.

## Future Goals / Roadmap
- Monitor for `aquire-persistent-storage-denied` errors to further refine Puppeteer arguments.
- Enhance webhook retry logic if the endpoint is temporarily unavailable.
- Explore alternative `webVersionCache` strategies if WhatsApp Web updates break the current pinned version.
