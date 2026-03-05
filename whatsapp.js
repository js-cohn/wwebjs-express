const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const path = require("path");
const fs = require("fs");
const {
  postWebhook,
  buildPublicFileUrl,
  sanitizeFilename,
  resolveSafePath,
  transcribeAudio,
} = require("./utils");

// --- Directory Constants ---
const SESSIONS_DIR = path.join(__dirname, "sessions");
const FILES_DIR = path.join(__dirname, "files");

// --- In-Memory Session State ---
// Stores active client instances, keyed by session ID.
const clients = {};
// Stores QR codes for sessions pending authentication, keyed by session ID.
const qrCodes = {};

/**
 * Starts a new WhatsApp session.
 * This involves creating a client, setting up event listeners, and initializing the connection.
 * @param {string} sessionId - A unique identifier for the session.
 * @returns {boolean} True if the session initialization started, false if the session already exists.
 */
function startSession(sessionId) {
  if (clients[sessionId]) return false;

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: sessionId,
      dataPath: SESSIONS_DIR,
    }),
    puppeteer: {
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--single-process",
        "--no-zygote",
      ],
    },
  });

  clients[sessionId] = client;

  // Watchdog to detect if the browser handshake hangs.
  let watchdog = setTimeout(async () => {
    const state = await client.getState().catch(() => null);
    if (!state || state === "INITIALIZING") {
      console.log(
        `[${sessionId}] ⚠️ Handshake hang detected. Force-reloading browser...`,
      );
      if (client.pupPage) await client.pupPage.reload().catch(() => {});
    }
  }, 120000); // 2 minutes

  // --- Client Event Handlers ---

  client.on("qr", (qr) => {
    qrCodes[sessionId] = qr;
  });

  client.on("ready", () => {
    clearTimeout(watchdog);
    delete qrCodes[sessionId];
    console.log(`✅ [${sessionId}] WhatsApp is Ready`);
    postWebhook({
      event: "session",
      session: sessionId,
      type: "ready",
      state: "READY",
    });
  });

  client.on("change_state", (state) => {
    postWebhook({
      event: "session",
      session: sessionId,
      type: "state_change",
      state: state || null,
    });
  });

  client.on("authenticated", () => {
    postWebhook({
      event: "session",
      session: sessionId,
      type: "authenticated",
    });
  });

  client.on("auth_failure", (message) => {
    postWebhook({
      event: "session",
      session: sessionId,
      type: "auth_failure",
      error: message || null,
    });
  });

  client.on("disconnected", (reason) => {
    clearTimeout(watchdog);
    postWebhook({
      event: "session",
      session: sessionId,
      type: "disconnected",
      reason: reason || null,
    });
  });

  // --- In-session Caching and Helpers ---
  // These are created per-session to avoid mixing data between clients.

  // Cache for message reactions to prevent duplicate webhook events.
  const recentReactionKeys = new Map();
  const reactionDedupWindowMs = 10 * 60 * 1000;

  // Cache for contact information to reduce API calls.
  const contactInfoCache = new Map();
  const contactInfoCacheTtlMs = 10 * 60 * 1000;

  /**
   * Extracts a phone number from a serialized WhatsApp ID (e.g., "1234567890@c.us").
   */
  function getNumberFromSerializedId(serializedId) {
    if (typeof serializedId !== "string") return null;
    const match = serializedId.trim().match(/^(\d+)@(c\.us|s\.whatsapp\.net)$/);
    return match ? match[1] : null;
  }

  /**
   * Normalizes a phone number by stripping non-digit characters.
   */
  function normalizePhoneNumber(value) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const digits = String(value).replace(/\D/g, "");
    return digits || null;
  }

  /**
   * Attempts to find a phone number from various fields of a contact object.
   */
  function getContactPhoneNumber(contact, fromId) {
    const directCandidates = [
      contact?.number,
      contact?.id?.user,
      contact?.phoneNumber,
    ];
    for (const candidate of directCandidates) {
      const parsed = normalizePhoneNumber(candidate);
      if (parsed) return parsed;
    }

    const idCandidates = [contact?.id?._serialized, fromId];
    for (const candidate of idCandidates) {
      const parsed = getNumberFromSerializedId(candidate);
      if (parsed) return parsed;
    }

    return null;
  }

  /**
   * Resolves contact information (name and phone number) from a "from" ID.
   * Uses an in-memory cache to avoid repeated lookups.
   */
  async function resolveContactInfo(from, fallbackNotifyName = null) {
    const fallbackName =
      typeof fallbackNotifyName === "string" && fallbackNotifyName.trim()
        ? fallbackNotifyName.trim()
        : null;
    if (typeof from !== "string" || !from.trim()) {
      return { notifyName: fallbackName, phoneNumber: null };
    }

    const contactId = from.trim();
    const fallbackPhoneNumber = getNumberFromSerializedId(contactId);

    const now = Date.now();
    const cached = contactInfoCache.get(contactId);
    if (cached && now - cached.at <= contactInfoCacheTtlMs) {
      return {
        notifyName: fallbackName || cached.notifyName,
        phoneNumber: cached.phoneNumber || fallbackPhoneNumber,
      };
    }

    try {
      const contact = await client.getContactById(contactId);
      const notifyName =
        fallbackName ||
        contact?.pushname ||
        contact?.name ||
        contact?.shortName ||
        contact?.formattedName ||
        null;
      const phoneNumber = getContactPhoneNumber(contact, contactId);
      const resolved = {
        notifyName,
        phoneNumber: phoneNumber || fallbackPhoneNumber,
      };
      contactInfoCache.set(contactId, { ...resolved, at: now });
      return resolved;
    } catch {
      // On failure, cache the fallback to prevent repeated failed lookups.
      const fallbackResolved = {
        notifyName: fallbackName,
        phoneNumber: fallbackPhoneNumber,
      };
      contactInfoCache.set(contactId, { ...fallbackResolved, at: now });
      return fallbackResolved;
    }
  }

  /**
   * De-duplicates and sends a webhook for a message reaction.
   */
  function emitReactionWebhook(payload, meta = {}) {
    const key = [
      payload.session || "",
      meta.fromMe ? "1" : "0",
      payload.from || "",
      payload.body || "",
      meta.msgId || "",
      meta.timestamp || "",
      meta.orphan ? "1" : "0",
    ].join("|");

    const now = Date.now();
    // Clean up old keys from the cache.
    for (const [cachedKey, seenAt] of recentReactionKeys) {
      if (now - seenAt > reactionDedupWindowMs) {
        recentReactionKeys.delete(cachedKey);
      }
    }

    if (recentReactionKeys.has(key)) return; // Deduplicate
    recentReactionKeys.set(key, now);

    postWebhook({
      event: "message",
      session: payload.session || sessionId,
      from: payload.from || null,
      body: payload.body || "",
      type: "reaction",
      notifyName: payload.notifyName || null,
      phoneNumber: payload.phoneNumber || null,
    });
  }

  // --- Message-related Event Handlers ---

  client.on("message", async (msg) => {
    if (msg.from === "status@broadcast" || msg.type === "reaction") return;

    const contactInfo = await resolveContactInfo(
      msg.author || msg.from,
      msg._data?.notifyName,
    );

    let payload = {
      event: "message",
      session: sessionId,
      from: msg.from,
      body: msg.body,
      type: msg.type,
      notifyName: contactInfo.notifyName,
      phoneNumber: contactInfo.phoneNumber,
    };

    const downloadableTypes = [
      "image",
      "video",
      "audio",
      "document",
      "ptt",
      "sticker",
    ];
    if (msg.hasMedia && downloadableTypes.includes(msg.type)) {
      try {
        const media = await msg.downloadMedia();
        if (media && media.data) {
          const ext = media.mimetype?.split("/")[1]?.split(";")[0] || "bin";
          const fallbackName = `${msg.type}_${Date.now()}.${ext}`;
          const originalName = sanitizeFilename(
            msg._data?.filename || fallbackName,
            fallbackName,
          );
          const safeFilename = `${Date.now()}_${originalName}`;
          const fullPath = resolveSafePath(FILES_DIR, safeFilename);

          fs.writeFileSync(fullPath, media.data, "base64");

          payload.media = {
            url: buildPublicFileUrl(safeFilename),
            mimetype: media.mimetype,
            filename: originalName,
          };

          if (msg.type === "ptt" || msg.type === "audio") {
            try {
              const transcriptText = await transcribeAudio(fullPath);
              payload.body = transcriptText || "[Inaudible Audio]";
            } catch (transcriptionError) {
              console.error(
                `[${sessionId}] Transcription error:`,
                transcriptionError.message,
              );
              payload.body = "[Transcription Failed]";
            }
          }
        }
      } catch (e) {
        console.error(`[${sessionId}] Media download error:`, e.message);
      }
    }

    postWebhook(payload);
  });

  client.on("message_reaction", async (reaction) => {
    const selfWid = client.info?.wid?._serialized || null;
    const fromMe = Boolean(
      reaction.fromMe || (selfWid && reaction.senderId === selfWid),
    );
    const from =
      reaction.senderId ||
      reaction.id?.participant ||
      reaction.id?.remote ||
      null;
    const contactInfo = await resolveContactInfo(from);

    emitReactionWebhook(
      {
        session: sessionId,
        from,
        body: reaction.reaction || "",
        notifyName: contactInfo.notifyName,
        phoneNumber: contactInfo.phoneNumber,
      },
      {
        fromMe,
        msgId: reaction.msgId?._serialized || reaction.msgId || null,
        orphan: Boolean(reaction.orphan),
        timestamp: reaction.timestamp || null,
      },
    );
  });

  // `message_create` is another event that can signify a reaction.
  client.on("message_create", async (msg) => {
    if (msg.type !== "reaction") return;

    const data = msg._data || {};
    const emoji = msg.body || data.reaction || "";
    const from =
      msg.author ||
      msg.from ||
      data.author?._serialized ||
      data.from?._serialized ||
      null;
    const contactInfo = await resolveContactInfo(from, msg._data?.notifyName);
    const parentMsgId =
      data.reactionParentKey?._serialized ||
      data.parentMsgKey?._serialized ||
      data.msgId?._serialized ||
      data.msgId ||
      null;

    emitReactionWebhook(
      {
        session: sessionId,
        from,
        body: emoji,
        notifyName: contactInfo.notifyName,
        phoneNumber: contactInfo.phoneNumber,
      },
      {
        fromMe: Boolean(msg.fromMe),
        msgId: parentMsgId || msg.id?._serialized || null,
        orphan: Boolean(data.orphan),
        timestamp: msg.timestamp || data.t || null,
      },
    );
  });

  client
    .initialize()
    .catch((err) => console.error(`[${sessionId}] Init error:`, err));

  return true;
}

/**
 * Stops a WhatsApp session, logs out, and cleans up resources.
 * @param {string} sessionId - The ID of the session to stop.
 * @returns {Promise<boolean>} True if the session was stopped, false if it was not found.
 */
async function stopSession(sessionId) {
  const client = clients[sessionId];
  if (!client) return false;

  try {
    await client.logout();
  } catch (e) {
    console.error(
      `[${sessionId}] Failed to logout, attempting to destroy:`,
      e.message,
    );
    try {
      await client.destroy();
    } catch (e2) {
      console.error(`[${sessionId}] Failed to destroy client:`, e2.message);
    }
  }

  delete clients[sessionId];
  delete qrCodes[sessionId];
  return true;
}

/**
 * Retrieves an active session client instance.
 * @param {string} sessionId - The ID of the session.
 * @returns {Client|undefined} The client instance or undefined if not found.
 */
function getSession(sessionId) {
  return clients[sessionId];
}

/**
 * Retrieves the QR code for a session pending authentication.
 * @param {string} sessionId - The ID of the session.
 * @returns {string|undefined} The QR code string or undefined if not available.
 */
function getQrCode(sessionId) {
  return qrCodes[sessionId];
}

/**
 * Gathers the state of all active and initializing sessions.
 * @returns {Promise<Object<string, string>>} A promise that resolves to an object of session states.
 */
async function getSessionStats() {
  const stats = {};
  for (const id in clients) {
    const state = await clients[id].getState().catch(() => "OFFLINE");
    stats[id] = state || "INITIALIZING";
  }
  return stats;
}

/**
 * Sends a text message.
 * @param {string} sessionId - The session to use.
 * @param {string} to - The recipient's ID (e.g., "1234567890" or "1234567890@c.us").
 * @param {string} text - The message text.
 * @returns {Promise<true>}
 */
async function sendMessage(sessionId, to, text) {
  const client = getSession(sessionId);
  if (!client) throw new Error("Session not active");

  const chatId = to.includes("@") ? to : `${to}@c.us`;
  await client.sendMessage(chatId, text);
  return true;
}

/**
 * Sends a file from a buffer.
 * @param {string} sessionId - The session to use.
 * @param {string} to - The recipient's ID.
 * @param {Buffer} fileBuffer - The file content as a buffer.
 * @param {string} contentType - The MIME type of the file.
 * @param {string} inferredName - The filename to use.
 * @param {string} caption - An optional caption for the file.
 * @returns {Promise<true>}
 */
async function sendFile(
  sessionId,
  to,
  fileBuffer,
  contentType,
  inferredName,
  caption,
) {
  const client = getSession(sessionId);
  if (!client) throw new Error("Session not active");

  const media = new MessageMedia(
    contentType,
    fileBuffer.toString("base64"),
    inferredName,
  );

  const chatId = to.includes("@") ? to : `${to}@c.us`;
  const safeCaption = typeof caption === "string" ? caption : "";
  // Always send as a document to preserve file type and name.
  await client.sendMessage(chatId, media, {
    sendMediaAsDocument: true,
    caption: safeCaption,
  });
  return true;
}

module.exports = {
  startSession,
  stopSession,
  getSession,
  getQrCode,
  getSessionStats,
  sendMessage,
  sendFile,
};
