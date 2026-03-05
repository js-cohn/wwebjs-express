const express = require("express");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const {
  startSession,
  stopSession,
  getSession,
  getQrCode,
  getSessionStats,
  sendMessage,
  sendFile,
} = require("./whatsapp");
const {
  maxDownloadSizeBytes,
  downloadWithSafeRedirects,
  classifySendFileError,
  sanitizeFilename,
  resolveSafePath,
} = require("./utils");

const router = express.Router();
const FILES_DIR = path.join(__dirname, "files");

/**
 * Escapes user-controlled text before embedding into HTML responses.
 * Used by /web-image to prevent reflected HTML/script injection.
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * --- Management Endpoint ---
 * Starts a new WhatsApp session.
 * @param {string} id - The session ID.
 * @returns {string} A confirmation message.
 * 200: Session initialization started or already running.
 */
router.get("/web-start/:id", (req, res) => {
  const sessionId = req.params.id;
  if (getSession(sessionId)) {
    return res.send(`Session ${sessionId} is already running.`);
  }
  startSession(sessionId);
  res.send(`Session ${sessionId} initialization started.`);
});

/**
 * --- Management Endpoint ---
 * Stops a WhatsApp session.
 * @param {string} id - The session ID.
 * @returns {string} A confirmation message.
 * 200: Session stopped.
 * 404: Session not found.
 */
router.get("/web-stop/:id", async (req, res) => {
  const sessionId = req.params.id;
  const stopped = await stopSession(sessionId);
  if (stopped) {
    res.send(`Session ${sessionId} has been stopped.`);
  } else {
    res.status(404).send(`Session ${sessionId} not found.`);
  }
});

/**
 * --- Management Endpoint ---
 * Renders a QR code for authentication or a live screenshot of the session.
 * @param {string} id - The session ID.
 * @returns {string} HTML page with the QR code or screenshot.
 * 200: QR/screenshot page rendered.
 * 404: Session not found.
 * 500: Failed to capture screenshot.
 */
router.get("/web-image/:id", async (req, res) => {
  const sessionId = req.params.id;
  const safeSessionId = escapeHtml(sessionId);
  const client = getSession(sessionId);
  if (!client) {
    return res.status(404).send("Session not found. Run /web-start first.");
  }

  const qr = getQrCode(sessionId);
  if (qr) {
    const url = await qrcode.toDataURL(qr);
    return res.send(
      `<html><body style="background:#111;text-align:center;"><h2 style="color:white;">Scan QR: ${safeSessionId}</h2><img src="${url}" style="width:350px;border:10px solid white;margin-top:20px;"></body></html>`,
    );
  }

  if (client.pupPage) {
    try {
      const screenshot = await client.pupPage.screenshot({
        encoding: "base64",
      });
      return res.send(
        `<html><body style="background:#222;text-align:center;"><h2 style="color:white;">Live View: ${safeSessionId}</h2><img src="data:image/png;base64,${screenshot}" style="width:90%;border:5px solid #444;"></body></html>`,
      );
    } catch (e) {
      return res.status(500).send("Failed to capture screenshot.");
    }
  }
  res.send("Session is starting... please refresh in a moment.");
});

/**
 * --- Management Endpoint ---
 * Returns the status of all active sessions.
 * @returns {object} A JSON object mapping session IDs to their state.
 */
router.get("/web-stats", async (req, res) => {
  const stats = await getSessionStats();
  res.json(
    Object.keys(stats).length > 0
      ? stats
      : { status: "running", active_sessions: 0 },
  );
});

/**
 * --- API Endpoint ---
 * Sends a text message.
 * @body {{session: string, to: string, text: string}}
 * @returns {object} JSON response indicating success or failure.
 * 200: { success: true }
 * 400: Invalid request body.
 * 404: Session not active.
 * 500: Failed to send message.
 */
router.post("/send-text", async (req, res) => {
  const { session, to, text } = req.body || {};
  if (typeof session !== "string" || !session.trim()) {
    return res.status(400).json({ error: "Invalid session" });
  }
  if (typeof to !== "string" || !to.trim()) {
    return res.status(400).json({ error: "Invalid destination" });
  }
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Invalid text body" });
  }

  const sessionId = session.trim();
  const recipient = to.trim();

  try {
    await sendMessage(sessionId, recipient, text);
    res.json({ success: true });
  } catch (e) {
    const message = e.message || "Failed to send message";
    res
      .status(message === "Session not active" ? 404 : 500)
      .json({ error: message });
  }
});

/**
 * --- API Endpoint ---
 * Downloads a file from a URL and sends it as a message.
 * @body {{session: string, to: string, url: string, filename?: string, caption?: string}}
 * @returns {object} JSON response indicating success or failure.
 * 200: { success: true, local_file: string }
 * 400: Invalid request body or unsafe URL.
 * 404: Session not active.
 * 413: File exceeds maximum size.
 * 500: Failed to process file.
 * 504: File download timed out.
 */
router.post("/send-file", async (req, res) => {
  const { session, to, url, filename, caption } = req.body || {};
  if (typeof session !== "string" || !session.trim()) {
    return res.status(400).json({ error: "Invalid session" });
  }
  const sessionId = session.trim();
  if (!getSession(sessionId)) {
    return res.status(404).json({ error: "Session not active" });
  }
  if (!url || typeof url !== "string")
    return res.status(400).json({ error: "Invalid file URL" });
  if (!to || typeof to !== "string" || !to.trim())
    return res.status(400).json({ error: "Invalid destination" });
  const recipient = to.trim();

  try {
    // 1. Download the file with security checks.
    const { response, finalUrl } = await downloadWithSafeRedirects(url);

    const fileBuffer = Buffer.from(response.data);
    if (fileBuffer.length > maxDownloadSizeBytes) {
      throw new Error("File exceeds maximum size");
    }

    // 2. Determine the filename.
    const parsedUrl = new URL(finalUrl);
    const filenameCandidate =
      typeof filename === "string" && filename.trim()
        ? filename
        : path.basename(parsedUrl.pathname);
    const inferredName = sanitizeFilename(
      filenameCandidate || "file.bin",
      "file.bin",
    );

    const contentType =
      response.headers["content-type"] || "application/octet-stream";

    // 3. Send the file via WhatsApp.
    await sendFile(
      sessionId,
      recipient,
      fileBuffer,
      contentType,
      inferredName,
      caption,
    );

    // 4. (Optional) Save a local copy for access via /files/*
    const safeFilename = `out_${Date.now()}_${inferredName}`;
    const fullPath = resolveSafePath(FILES_DIR, safeFilename);
    fs.writeFileSync(fullPath, fileBuffer);

    res.json({ success: true, local_file: safeFilename });
  } catch (e) {
    const result = classifySendFileError(e);
    res.status(result.status).json({ error: result.error });
  }
});

module.exports = router;
