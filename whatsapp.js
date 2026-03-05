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
// Tracks scheduled init retries per session to avoid duplicate timers.
const initRetryTimers = {};
// Tracks how many init retries have been attempted per session.
const initRetryCounts = {};
const MAX_INIT_RETRIES = 3;

/**
 * Returns true when an init error is likely transient and worth retrying.
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableInitError(error) {
  const message = String(error?.message || "");
  return (
    /Execution context was destroyed/i.test(message) ||
    /Target closed/i.test(message) ||
    /Session closed/i.test(message) ||
    /Navigation failed because browser has disconnected/i.test(message)
  );
}

/**
 * Starts a new WhatsApp session.
 * This involves creating a client, setting up event listeners, and initializing the connection.
 * @param {string} sessionId - A unique identifier for the session.
 * @param {{preserveRetryCount?: boolean}} [options] - Optional startup flags.
 * @returns {boolean} True if the session initialization started, false if the session already exists.
 */
function startSession(sessionId, options = {}) {
  const { preserveRetryCount = false } = options;
  if (clients[sessionId]) return false;
  if (!preserveRetryCount) {
    delete initRetryCounts[sessionId];
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: sessionId,
      dataPath: SESSIONS_DIR,
    }),
    puppeteer: {
      // Favor stable headless mode for long-running Linux servers.
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    },
  });

  clients[sessionId] = client;
  let isRecycling = false;

  /**
   * Tears down a stuck/broken client and schedules a bounded retry when allowed.
   * @param {{reason: string, error?: unknown, retryable?: boolean}} params
   */
  async function recycleAndMaybeRetry(params) {
    const { reason, error = null, retryable = true } = params;
    if (isRecycling) return;
    isRecycling = true;

    clearTimeout(watchdog);
    if (error) {
      console.error(`[${sessionId}] ${reason}:`, error);
    } else {
      console.warn(`[${sessionId}] ${reason}`);
    }

    try {
      await client.destroy();
    } catch {
      // no-op
    }

    if (clients[sessionId] === client) {
      delete clients[sessionId];
    }
    delete qrCodes[sessionId];

    const nextAttempt = (initRetryCounts[sessionId] || 0) + 1;
    if (retryable && nextAttempt <= MAX_INIT_RETRIES) {
      initRetryCounts[sessionId] = nextAttempt;
      const delayMs = nextAttempt * 2000;
      console.warn(
        `[${sessionId}] Retrying initialization (${nextAttempt}/${MAX_INIT_RETRIES}) in ${delayMs}ms...`,
      );
      if (!initRetryTimers[sessionId]) {
        initRetryTimers[sessionId] = setTimeout(() => {
          delete initRetryTimers[sessionId];
          startSession(sessionId, { preserveRetryCount: true });
        }, delayMs);
      }
      return;
    }

    delete initRetryCounts[sessionId];
    if (retryable) {
      console.error(
        `[${sessionId}] Reached max initialization retries (${MAX_INIT_RETRIES}). Session remains stopped.`,
      );
    }
  }

  // Watchdog to detect if browser startup is stuck.
  let watchdog = setTimeout(async () => {
    const state = await client.getState().catch(() => null);
    if (!state || state === "INITIALIZING") {
      await recycleAndMaybeRetry({
        reason: "⚠️ Handshake hang detected while INITIALIZING",
        retryable: true,
      });
    }
  }, 60000); // 1 minute

  // --- Client Event Handlers ---

  client.on("qr", (qr) => {
    qrCodes[sessionId] = qr;
  });

  client.on("ready", () => {
    clearTimeout(watchdog);
    delete qrCodes[sessionId];
    if (initRetryTimers[sessionId]) {
      clearTimeout(initRetryTimers[sessionId]);
      delete initRetryTimers[sessionId];
    }
    delete initRetryCounts[sessionId];
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

  const tryInitialize = () => {
    client.initialize().catch(async (err) => {
      await recycleAndMaybeRetry({
        reason: "Init error",
        error: err,
        retryable: isRetryableInitError(err),
      });
    });
  };

  tryInitialize();

  return true;
}

/**
 * Restores persisted LocalAuth sessions from disk at process startup.
 * LocalAuth stores session data under directories like `session-<id>`.
 * @returns {{restored: string[], skipped: string[]}} Restored and skipped IDs.
 */
function restorePersistedSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    return { restored: [], skipped: [] };
  }

  const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  const persistedIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("session-"))
    .map((name) => name.slice(8))
    .map((id) => id.trim())
    .filter(Boolean);

  const restored = [];
  const skipped = [];
  for (const sessionId of [...new Set(persistedIds)]) {
    const started = startSession(sessionId);
    if (started) restored.push(sessionId);
    else skipped.push(sessionId);
  }

  return { restored, skipped };
}

/**
 * Stops a WhatsApp session, logs out, and cleans up resources.
 * @param {string} sessionId - The ID of the session to stop.
 * @returns {Promise<boolean>} True if the session was stopped, false if it was not found.
 */
async function stopSession(sessionId) {
  const hadPendingRetry = Boolean(initRetryTimers[sessionId]);
  if (hadPendingRetry) {
    clearTimeout(initRetryTimers[sessionId]);
    delete initRetryTimers[sessionId];
  }
  delete initRetryCounts[sessionId];

  const client = clients[sessionId];
  if (!client) return hadPendingRetry;

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
 * Builds candidate chat IDs for a recipient.
 * Uses getNumberId when possible so WhatsApp chooses the correct ID type (e.g. @lid).
 * @param {Client} client - Active WhatsApp client instance.
 * @param {string} to - Destination from API request.
 * @returns {Promise<string[]>} Ordered unique candidate chat IDs.
 */
async function buildRecipientCandidates(client, to) {
  const raw = String(to || "").trim();
  const explicitId = raw.includes("@") ? raw : null;

  let numeric = null;
  if (explicitId) {
    const [user, server] = explicitId.split("@");
    if (
      /^\d+$/.test(user || "") &&
      ["c.us", "s.whatsapp.net", "lid"].includes(server)
    ) {
      numeric = user;
    }
  } else {
    const digits = raw.replace(/\D/g, "");
    numeric = digits || null;
  }

  const candidates = [];
  if (numeric) {
    const numberId = await client.getNumberId(numeric).catch(() => null);
    const resolvedId =
      numberId?._serialized ||
      (numberId?.user && numberId?.server
        ? `${numberId.user}@${numberId.server}`
        : null);
    if (resolvedId) candidates.push(resolvedId);
  }

  if (explicitId) {
    candidates.push(explicitId);
  } else if (numeric) {
    candidates.push(`${numeric}@c.us`);
  }

  // Fallback pair for direct contacts only; used if WhatsApp rejects one ID type.
  if (numeric) {
    candidates.push(`${numeric}@c.us`);
    candidates.push(`${numeric}@lid`);
  }

  return [...new Set(candidates)];
}

/**
 * True when WhatsApp fails to resolve a candidate destination ID.
 * In these cases, trying the next candidate ID shape is usually correct.
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableDestinationError(error) {
  const message = String(error?.message || "");
  return (
    /lid is missing in chat table/i.test(message) ||
    /cannot read properties of undefined \(reading 'getchat'\)/i.test(message)
  );
}

/**
 * Sends to a recipient with ID fallback behavior for destination lookup failures.
 * @param {Client} client - Active WhatsApp client instance.
 * @param {string} to - Destination from API request.
 * @param {(chatId: string) => Promise<void>} sendFn - Send function for text/media.
 */
async function sendWithRecipientFallback(client, to, sendFn) {
  const candidates = await buildRecipientCandidates(client, to);
  if (!candidates.length) {
    throw new Error("Invalid destination");
  }

  let lastError = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const chatId = candidates[i];
    try {
      await sendFn(chatId);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableDestinationError(error) || i === candidates.length - 1) {
        throw error;
      }
    }
  }

  throw lastError || new Error("Failed to resolve destination");
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

  await sendWithRecipientFallback(client, to, async (chatId) => {
    await client.sendMessage(chatId, text);
  });
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

  const safeCaption = typeof caption === "string" ? caption : "";
  // Always send as a document to preserve file type and name.
  await sendWithRecipientFallback(client, to, async (chatId) => {
    await client.sendMessage(chatId, media, {
      sendMediaAsDocument: true,
      caption: safeCaption,
    });
  });
  return true;
}

module.exports = {
  startSession,
  restorePersistedSessions,
  stopSession,
  getSession,
  getQrCode,
  getSessionStats,
  sendMessage,
  sendFile,
};
