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
// Sessions that were explicitly paused and should replay unread chat messages after the next ready event.
const resumeUnreadReplaySessions = new Set();
const SESSION_STATE_TIMEOUT_MS = 2000;
const STARTUP_DIAGNOSTICS_POLL_MS = 1000;
const MAX_READY_TIMEOUT_MS = 300000; // 5 minutes
const IGNORED_SYSTEM_MESSAGE_TYPES = new Set([
  "notification_template",
  "e2e_notification",
  "call_log",
]);

/**
 * Removes a client from in-memory state only if it is still the current client.
 * This avoids stale event handlers deleting a newer client for the same session.
 * @param {string} sessionId
 * @param {Client} client
 */
function removeClientIfCurrent(sessionId, client) {
  if (clients[sessionId] === client) {
    delete clients[sessionId];
  }
  delete qrCodes[sessionId];
}

/**
 * Bounds client.getState() so wedged browser contexts do not hang routes/watchdogs.
 * @param {Client} client
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>}
 */
async function getClientStateWithTimeout(
  client,
  timeoutMs = SESSION_STATE_TIMEOUT_MS,
) {
  let timer = null;
  try {
    return await Promise.race([
      client.getState().catch(() => "OFFLINE"),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("OFFLINE"), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Best-effort page URL lookup for diagnostics.
 * @param {import('puppeteer-core').Page|undefined|null} page
 * @returns {Promise<string|null>}
 */
async function getPageUrlSafe(page) {
  if (!page) return null;
  try {
    return page.url() || null;
  } catch {
    return null;
  }
}

/**
 * Formats startup diagnostics as a compact log suffix.
 * @param {Record<string, unknown>} diagnostics
 * @returns {string}
 */
function formatStartupDiagnostics(diagnostics) {
  const parts = [];
  if (diagnostics.elapsedMs != null) {
    parts.push(`elapsed=${diagnostics.elapsedMs}ms`);
  }
  if (diagnostics.lastState) {
    parts.push(`state=${diagnostics.lastState}`);
  }
  if (diagnostics.lastLoadingPercent != null) {
    parts.push(`loading=${diagnostics.lastLoadingPercent}%`);
  }
  if (diagnostics.hasBrowser) {
    parts.push("browser=attached");
  }
  if (diagnostics.hasPage) {
    parts.push("page=attached");
  }
  if (diagnostics.lastPageUrl) {
    parts.push(`url=${diagnostics.lastPageUrl}`);
  }
  if (diagnostics.qrSeen) {
    parts.push("qr=seen");
  }
  if (diagnostics.authenticated) {
    parts.push("authenticated=yes");
  }
  if (diagnostics.ready) {
    parts.push("ready=yes");
  }
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/**
 * Starts a new WhatsApp session.
 * This involves creating a client, setting up event listeners, and initializing the connection.
 * @param {string} sessionId - A unique identifier for the session.
 * @returns {boolean} True if the session initialization started, false if the session already exists.
 */
function startSession(sessionId) {
  if (clients[sessionId]) return false;

  const sessionPath = path.join(SESSIONS_DIR, `session-${sessionId}`);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: sessionId,
      dataPath: SESSIONS_DIR,
    }),
    webVersionCache: {
      type: "remote",
      remotePath:
        "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
    },
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
        "--disable-site-isolation-trials",
        "--no-zygote",
      ],
    },
  });

  clients[sessionId] = client;
  let isCleaningUp = false;
  let hasAnnouncedAuthenticated = false;
  let hasAnnouncedReady = false;
  const startupState = {
    startedAt: Date.now(),
    initializeCalledAt: null,
    initializeResolvedAt: null,
    qrSeenAt: null,
    authenticatedAt: null,
    readyAt: null,
    lastState: null,
    lastLoadingPercent: null,
    lastPageUrl: null,
    browserAttachedAt: null,
    pageAttachedAt: null,
    browserDisconnectedAt: null,
  };
  let startupDiagnosticsTimer = null;
  let browserListenersAttached = false;
  let pageListenersAttached = false;

  function startupLog(message, details = null, level = "log") {
    const suffix = formatStartupDiagnostics({
      elapsedMs: Date.now() - startupState.startedAt,
      lastState: startupState.lastState,
      lastLoadingPercent: startupState.lastLoadingPercent,
      hasBrowser: Boolean(client.pupBrowser),
      hasPage: Boolean(client.pupPage),
      lastPageUrl: startupState.lastPageUrl,
      qrSeen: Boolean(startupState.qrSeenAt),
      authenticated: Boolean(startupState.authenticatedAt),
      ready: Boolean(startupState.readyAt),
    });
    const logger =
      level === "warn"
        ? console.warn
        : level === "error"
          ? console.error
          : console.log;
    if (details != null) {
      logger(`[${sessionId}] ${message}${suffix}:`, details);
    } else {
      logger(`[${sessionId}] ${message}${suffix}`);
    }
  }

  async function attachStartupDiagnostics() {
    if (isCleaningUp || hasAnnouncedReady) return;

    if (!browserListenersAttached && client.pupBrowser) {
      browserListenersAttached = true;
      startupState.browserAttachedAt = Date.now();
      startupLog("Browser attached");
      client.pupBrowser.on("disconnected", () => {
        startupState.browserDisconnectedAt = Date.now();
        startupLog("Browser disconnected", null, "warn");
      });
      client.pupBrowser.on("targetcreated", async (target) => {
        if (target.type() === "page") {
          startupLog(`Browser target created: ${target.type()}`);
        }
      });
      client.pupBrowser.on("targetdestroyed", async (target) => {
        if (target.type() === "page") {
          startupLog(
            `Browser target destroyed: ${target.type()}`,
            null,
            "warn",
          );
        }
      });
    }

    if (!pageListenersAttached && client.pupPage) {
      pageListenersAttached = true;
      startupState.pageAttachedAt = Date.now();
      startupState.lastPageUrl = await getPageUrlSafe(client.pupPage);
      startupLog("Page attached");
      client.pupPage.on("domcontentloaded", async () => {
        startupState.lastPageUrl = await getPageUrlSafe(client.pupPage);
        startupLog("Page DOMContentLoaded");
      });
      client.pupPage.on("load", async () => {
        startupState.lastPageUrl = await getPageUrlSafe(client.pupPage);
        startupLog("Page load");
      });
      client.pupPage.on("framenavigated", async (frame) => {
        if (frame === client.pupPage.mainFrame()) {
          startupState.lastPageUrl = await getPageUrlSafe(client.pupPage);
          startupLog("Main frame navigated");
        }
      });
      client.pupPage.on("pageerror", (error) => {
        startupLog("Page error", error?.message || error, "warn");
      });
      client.pupPage.on("error", (error) => {
        startupLog("Page crash/error", error?.message || error, "warn");
      });
      client.pupPage.on("close", () => {
        startupLog("Page closed", null, "warn");
      });
      client.pupPage.on("console", (message) => {
        if (message.type() === "error") {
          startupLog(`Page console ${message.type()}`, message.text(), "warn");
        }
      });
      client.pupPage.on("requestfailed", (request) => {
        const failureText = request.failure()?.errorText || "unknown";
        startupLog(
          `Request failed: ${request.method()} ${request.url()} (${failureText})`,
          null,
          "warn",
        );
      });
    }
  }

  function startStartupDiagnosticsLoop() {
    attachStartupDiagnostics().catch((error) => {
      startupLog(
        "Startup diagnostics attach failed",
        error?.message || error,
        "warn",
      );
    });
    startupDiagnosticsTimer = setInterval(() => {
      attachStartupDiagnostics().catch((error) => {
        startupLog(
          "Startup diagnostics attach failed",
          error?.message || error,
          "warn",
        );
      });
    }, STARTUP_DIAGNOSTICS_POLL_MS);
    startupDiagnosticsTimer.unref?.();
  }

  function stopStartupDiagnosticsLoop() {
    if (startupDiagnosticsTimer) {
      clearInterval(startupDiagnosticsTimer);
      startupDiagnosticsTimer = null;
    }
  }

  /**
   * Tears down a stuck/broken client so a fresh /web-start can be attempted.
   * @param {{reason: string, error?: unknown}} params
   */
  async function cleanupFailedClient(params) {
    const { reason, error = null } = params;
    if (isCleaningUp) return;
    isCleaningUp = true;

    clearTimeout(watchdog);
    stopStartupDiagnosticsLoop();
    if (error) {
      startupLog(reason, error, "error");
    } else {
      startupLog(reason, null, "warn");
    }

    try {
      await client.destroy();
    } catch {
      // no-op
    }

    removeClientIfCurrent(sessionId, client);
  }

  // Watchdog to detect if browser startup is stuck.
  let watchdog = null;
  const runWatchdogCheck = () => {
    if (hasAnnouncedReady || isCleaningUp) return;

    watchdog = setTimeout(async () => {
      if (hasAnnouncedReady || isCleaningUp) return;

      const state = await getClientStateWithTimeout(client);
      startupState.lastState = state;
      startupState.lastPageUrl = await getPageUrlSafe(client.pupPage);

      const elapsed = Date.now() - startupState.startedAt;

      // If we've been trying for too long without reaching READY, give up.
      if (elapsed > MAX_READY_TIMEOUT_MS) {
        await cleanupFailedClient({
          reason: `⚠️ Session failed to reach READY state within ${MAX_READY_TIMEOUT_MS / 1000}s. Tearing down.`,
        });
        return;
      }

      if (
        startupState.qrSeenAt &&
        !startupState.authenticatedAt &&
        !startupState.readyAt
      ) {
        startupLog(
          "QR is available and awaiting scan; keeping session alive.",
          null,
          "warn",
        );
      } else if (startupState.authenticatedAt && !startupState.readyAt) {
        startupLog(
          "Authenticated event received but READY has not fired yet; keeping session alive.",
          null,
          "warn",
        );
      } else if (!state || state === "INITIALIZING" || state === "OFFLINE") {
        if (elapsed > 60000) {
          await cleanupFailedClient({
            reason:
              "⚠️ Handshake hang detected while INITIALIZING. Call /web-start/:id to try again.",
          });
          return;
        }
      }

      runWatchdogCheck();
    }, 30000); // Check every 30s
    watchdog.unref?.();
  };

  runWatchdogCheck();

  // --- Client Event Handlers ---

  startupLog(
    `Starting session initialization (saved auth ${fs.existsSync(sessionPath) ? "found" : "not found"})`,
  );
  startStartupDiagnosticsLoop();

  client.on("qr", (qr) => {
    qrCodes[sessionId] = qr;
    startupState.qrSeenAt = Date.now();
    startupLog(`QR received (length ${String(qr || "").length})`);
  });

  client.on("ready", async () => {
    if (hasAnnouncedReady) return;
    hasAnnouncedReady = true;
    startupState.readyAt = Date.now();
    clearTimeout(watchdog);
    stopStartupDiagnosticsLoop();
    delete qrCodes[sessionId];
    console.log(`✅ [${sessionId}] WhatsApp is Ready`);
    postWebhook({
      event: "session",
      session: sessionId,
      type: "ready",
      state: "READY",
    });

    if (resumeUnreadReplaySessions.has(sessionId)) {
      resumeUnreadReplaySessions.delete(sessionId);
      try {
        await postLatestUnreadMessagesAfterResume();
      } catch (error) {
        console.error(
          `[${sessionId}] Resume unread replay failed:`,
          error.message,
        );
      }
    }
  });

  client.on("change_state", (state) => {
    startupState.lastState = state || null;
    startupLog(`State changed to ${state || "null"}`);
    postWebhook({
      event: "session",
      session: sessionId,
      type: "state_change",
      state: state || null,
    });
  });

  client.on("loading_screen", (percent, message) => {
    startupState.lastLoadingPercent = percent ?? null;
    startupLog(
      `Loading screen ${percent ?? "?"}%${
        message ? `: ${String(message).trim()}` : ""
      }`,
    );
  });

  client.on("authenticated", () => {
    if (hasAnnouncedAuthenticated) return;
    hasAnnouncedAuthenticated = true;
    startupState.authenticatedAt = Date.now();
    startupLog("Authenticated event received");
    postWebhook({
      event: "session",
      session: sessionId,
      type: "authenticated",
    });
  });

  client.on("auth_failure", (message) => {
    startupLog("Auth failure", message || null, "warn");
    postWebhook({
      event: "session",
      session: sessionId,
      type: "auth_failure",
      error: message || null,
    });
  });

  client.on("disconnected", (reason) => {
    clearTimeout(watchdog);
    stopStartupDiagnosticsLoop();
    removeClientIfCurrent(sessionId, client);
    startupLog("Disconnected event received", reason || null, "warn");
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
    const match = serializedId
      .trim()
      .match(/^(\d+)@(c\.us|s\.whatsapp\.net|lid)$/);
    if (!match) return null;

    const user = match[1];
    const server = match[2];

    // If it's a LID, the numeric part is an internal identifier, not a phone number.
    if (server === "lid") {
      return null;
    }

    return user;
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
  async function getContactPhoneNumber(contact, fromId) {
    if (!contact) return null;

    const isLid =
      contact.id?.server === "lid" || String(fromId).endsWith("@lid");
    const lidUser = isLid
      ? contact.id?.user || String(fromId).split("@")[0]
      : null;

    const directCandidates = [
      contact.number,
      contact.id?.user,
      contact.phoneNumber,
    ];

    for (const candidate of directCandidates) {
      const parsed = normalizePhoneNumber(candidate);
      if (parsed) {
        if (isLid && parsed === lidUser) continue;
        return parsed;
      }
    }

    // For LID contacts, try to get the linked phone number via getFormattedNumber.
    // This is the most reliable way to get the real phone number for a LID.
    try {
      const formatted = await contact.getFormattedNumber();
      const parsed = normalizePhoneNumber(formatted);
      if (parsed && parsed !== lidUser) return parsed;
    } catch {
      // ignore
    }

    const idCandidates = [contact.id?._serialized, fromId];
    for (const candidate of idCandidates) {
      const parsed = getNumberFromSerializedId(candidate);
      if (parsed) return parsed;
    }

    // Explicitly do not return the numeric part of a LID as a phone number.
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

    const resolveWithTimeout = async () => {
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Resolution timeout")),
          10000,
        );
        timer.unref?.();
      });

      try {
        const result = await Promise.race([
          (async () => {
            const contact = await client.getContactById(contactId);
            const notifyName =
              fallbackName ||
              contact?.pushname ||
              contact?.name ||
              contact?.shortName ||
              contact?.formattedName ||
              null;
            const phoneNumber = await getContactPhoneNumber(contact, contactId);
            return { notifyName, phoneNumber };
          })(),
          timeoutPromise,
        ]);
        return result;
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      const { notifyName, phoneNumber } = await resolveWithTimeout();
      const resolved = {
        notifyName,
        phoneNumber: phoneNumber, // Do NOT fall back to fallbackPhoneNumber if resolution failed to find a real number
      };
      contactInfoCache.set(contactId, { ...resolved, at: now });
      return resolved;
    } catch (e) {
      if (e.message !== "Resolution timeout") {
        console.error(`[${sessionId}] Contact resolution failed:`, e.message);
      }
      // On failure or timeout, cache the results without the LID-based fallback phoneNumber.
      const fallbackResolved = {
        notifyName: fallbackName,
        phoneNumber: null,
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

  async function buildMessageWebhookPayload(msg, extraPayload = {}) {
    if (msg.from === "status@broadcast") return;
    // Reactions are emitted separately as normalized message events below.
    if (msg.type === "reaction") return;
    if (IGNORED_SYSTEM_MESSAGE_TYPES.has(msg.type)) return;

    const contactId = msg.author || msg.from;
    const contactInfo = await resolveContactInfo(
      contactId,
      msg._data?.notifyName,
    );

    const payload = {
      event: "message",
      session: sessionId,
      messageId: msg.id?._serialized || null,
      from: msg.from,
      body: msg.body,
      type: msg.type,
      notifyName: contactInfo.notifyName,
      phoneNumber: contactInfo.phoneNumber,
      _debug: {
        resolvedFrom: contactId,
        hasContact: !!contactInfo.phoneNumber,
      },
      ...extraPayload,
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

    return payload;
  }

  async function postLatestUnreadMessagesAfterResume() {
    const chats = await client.getChats();
    const unreadChats = chats.filter((chat) => Number(chat.unreadCount) > 0);

    startupLog(
      `Replaying latest unread messages from ${unreadChats.length} chats`,
    );

    for (const chat of unreadChats) {
      try {
        const unreadCount = Math.max(1, Number(chat.unreadCount) || 1);
        const messages = await chat.fetchMessages({
          fromMe: false,
          limit: Math.min(unreadCount + 20, 100),
        });
        const latestUnreadMessage = messages
          .slice()
          .reverse()
          .find(
            (msg) =>
              msg.from !== "status@broadcast" &&
              msg.type !== "reaction" &&
              !IGNORED_SYSTEM_MESSAGE_TYPES.has(msg.type),
          );

        if (!latestUnreadMessage) continue;

        const payload = await buildMessageWebhookPayload(latestUnreadMessage, {
          replayedAfterResume: true,
          unreadCount,
        });
        if (payload) {
          postWebhook(payload);
        }
      } catch (error) {
        console.error(
          `[${sessionId}] Failed unread replay for ${chat.id?._serialized || "unknown chat"}:`,
          error.message,
        );
      }
    }
  }

  client.on("message", async (msg) => {
    try {
      const payload = await buildMessageWebhookPayload(msg);
      if (!payload) return;
      postWebhook(payload);
    } catch (error) {
      console.error(`[${sessionId}] Message handler error:`, error.message);
    }
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
    startupState.initializeCalledAt = Date.now();
    startupLog("Calling client.initialize()");
    const initPromise = client.initialize();
    initPromise.catch(async (err) => {
      await cleanupFailedClient({
        reason: "Init error",
        error: err,
      });
    });
    initPromise
      .then(() => {
        startupState.initializeResolvedAt = Date.now();
        startupLog("client.initialize() promise resolved");
      })
      .catch(() => {
        // The actual error path is handled by the primary catch above.
      });
  };

  tryInitialize();

  return true;
}

/**
 * Stops a WhatsApp session client and cleans up resources.
 * @param {string} sessionId - The ID of the session to stop.
 * @param {{logout?: boolean}} [options] - When true, also invalidates WhatsApp auth.
 * @returns {Promise<boolean>} True if the session was stopped, false if it was not found.
 */
async function stopSession(sessionId, options = {}) {
  const { logout = false } = options;
  const client = clients[sessionId];
  if (!client) return false;

  if (logout) {
    resumeUnreadReplaySessions.delete(sessionId);
  } else {
    resumeUnreadReplaySessions.add(sessionId);
  }

  try {
    if (logout) {
      await client.logout();
    } else {
      await client.destroy();
    }
  } catch (e) {
    console.error(
      `[${sessionId}] Failed to stop cleanly, forcing destroy:`,
      e.message,
    );
    try {
      await client.destroy();
    } catch (e2) {
      console.error(`[${sessionId}] Failed to destroy client:`, e2.message);
    }
  }

  removeClientIfCurrent(sessionId, client);
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
    const state = await getClientStateWithTimeout(clients[id]);
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
 * @param {{messageRe?: string}} [options] - Optional send options.
 * @returns {Promise<true>}
 */
async function sendMessage(sessionId, to, text, options = {}) {
  const client = getSession(sessionId);
  if (!client) throw new Error("Session not active");
  const sendOptions = {};
  if (options.messageRe) {
    sendOptions.quotedMessageId = options.messageRe;
  }

  await sendWithRecipientFallback(client, to, async (chatId) => {
    await client.sendMessage(chatId, text, sendOptions);
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
 * @param {{messageRe?: string}} [options] - Optional send options.
 * @returns {Promise<true>}
 */
async function sendFile(
  sessionId,
  to,
  fileBuffer,
  contentType,
  inferredName,
  caption,
  options = {},
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
      ...(options.messageRe ? { quotedMessageId: options.messageRe } : {}),
    });
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
