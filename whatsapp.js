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

const SESSIONS_DIR = path.join(__dirname, "sessions");
const FILES_DIR = path.join(__dirname, "files");

const clients = {};
const qrCodes = {};
const resumeUnreadReplaySessions = new Set();
const SESSION_STATE_TIMEOUT_MS = 2000;
const STARTUP_DIAGNOSTICS_POLL_MS = 1000;
const MAX_READY_TIMEOUT_MS = 300000;
const IGNORED_SYSTEM_MESSAGE_TYPES = new Set([
  "notification_template",
  "e2e_notification",
  "call_log",
]);

function removeClientIfCurrent(sessionId, client) {
  if (clients[sessionId] === client) delete clients[sessionId];
  delete qrCodes[sessionId];
}

async function getClientStateWithTimeout(client, timeoutMs = SESSION_STATE_TIMEOUT_MS) {
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

async function getPageUrlSafe(page) {
  if (!page) return null;
  try {
    return page.url() || null;
  } catch {
    return null;
  }
}

function formatStartupDiagnostics(diagnostics) {
  const parts = [];
  if (diagnostics.elapsedMs != null) parts.push(`elapsed=${diagnostics.elapsedMs}ms`);
  if (diagnostics.lastState) parts.push(`state=${diagnostics.lastState}`);
  if (diagnostics.lastLoadingPercent != null) parts.push(`loading=${diagnostics.lastLoadingPercent}%`);
  if (diagnostics.hasBrowser) parts.push("browser=attached");
  if (diagnostics.hasPage) parts.push("page=attached");
  if (diagnostics.lastPageUrl) parts.push(`url=${diagnostics.lastPageUrl}`);
  if (diagnostics.qrSeen) parts.push("qr=seen");
  if (diagnostics.authenticated) parts.push("authenticated=yes");
  if (diagnostics.ready) parts.push("ready=yes");
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function classifySerializedId(serializedId) {
  if (typeof serializedId !== "string" || !serializedId.trim()) {
    return { id: null, idType: "unknown", user: null, server: null };
  }

  const trimmed = serializedId.trim();
  const match = trimmed.match(/^(.+)@(c\.us|s\.whatsapp\.net|lid|g\.us)$/);
  if (!match) return { id: trimmed, idType: "unknown", user: null, server: null };

  const [, user, server] = match;
  return {
    id: trimmed,
    idType:
      server === "lid"
        ? "lid"
        : server === "g.us"
          ? "group"
          : server === "c.us" || server === "s.whatsapp.net"
            ? "phone"
            : "unknown",
    user,
    server,
  };
}

function normalizePhoneNumber(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = String(value).replace(/\D/g, "");
  return digits || null;
}

function extractChatIdFromMessageId(messageId) {
  if (typeof messageId !== "string") return null;
  const match = messageId.match(/^(?:true|false)_([^_]+@(?:c\.us|s\.whatsapp\.net|lid|g\.us))_/);
  return match ? match[1] : null;
}

function normalizeComparableChatId(chatId) {
  return typeof chatId === "string" ? chatId.trim().toLowerCase() : null;
}

function quotedMessageMatchesCandidate(messageRe, chatId) {
  if (!messageRe) return true;
  const quotedChatId = extractChatIdFromMessageId(messageRe);
  if (!quotedChatId) return false;
  return normalizeComparableChatId(quotedChatId) === normalizeComparableChatId(chatId);
}

function startSession(sessionId) {
  if (clients[sessionId]) return false;

  const sessionPath = path.join(SESSIONS_DIR, `session-${sessionId}`);
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId, dataPath: SESSIONS_DIR }),
    webVersionCache: {
      type: "remote",
      remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
    },
    puppeteer: {
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
    qrSeenAt: null,
    authenticatedAt: null,
    readyAt: null,
    lastState: null,
    lastLoadingPercent: null,
    lastPageUrl: null,
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
    const logger = level === "warn" ? console.warn : level === "error" ? console.error : console.log;
    if (details != null) logger(`[${sessionId}] ${message}${suffix}:`, details);
    else logger(`[${sessionId}] ${message}${suffix}`);
  }

  async function attachStartupDiagnostics() {
    if (isCleaningUp || hasAnnouncedReady) return;
    if (!browserListenersAttached && client.pupBrowser) {
      browserListenersAttached = true;
      startupLog("Browser attached");
      client.pupBrowser.on("disconnected", () => startupLog("Browser disconnected", null, "warn"));
      client.pupBrowser.on("targetcreated", (target) => {
        if (target.type() === "page") startupLog(`Browser target created: ${target.type()}`);
      });
      client.pupBrowser.on("targetdestroyed", (target) => {
        if (target.type() === "page") startupLog(`Browser target destroyed: ${target.type()}`, null, "warn");
      });
    }
    if (!pageListenersAttached && client.pupPage) {
      pageListenersAttached = true;
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
      client.pupPage.on("pageerror", (error) => startupLog("Page error", error?.message || error, "warn"));
      client.pupPage.on("error", (error) => startupLog("Page crash/error", error?.message || error, "warn"));
      client.pupPage.on("close", () => startupLog("Page closed", null, "warn"));
      client.pupPage.on("console", (message) => {
        if (message.type() === "error") startupLog(`Page console ${message.type()}`, message.text(), "warn");
      });
    }
  }

  function startStartupDiagnosticsLoop() {
    attachStartupDiagnostics().catch((error) => startupLog("Startup diagnostics attach failed", error?.message || error, "warn"));
    startupDiagnosticsTimer = setInterval(() => {
      attachStartupDiagnostics().catch((error) => startupLog("Startup diagnostics attach failed", error?.message || error, "warn"));
    }, STARTUP_DIAGNOSTICS_POLL_MS);
    startupDiagnosticsTimer.unref?.();
  }

  function stopStartupDiagnosticsLoop() {
    if (startupDiagnosticsTimer) clearInterval(startupDiagnosticsTimer);
    startupDiagnosticsTimer = null;
  }

  let watchdog = null;
  async function cleanupFailedClient({ reason, error = null }) {
    if (isCleaningUp) return;
    isCleaningUp = true;
    clearTimeout(watchdog);
    stopStartupDiagnosticsLoop();
    startupLog(reason, error, error ? "error" : "warn");
    try {
      await client.destroy();
    } catch {}
    removeClientIfCurrent(sessionId, client);
  }

  const runWatchdogCheck = () => {
    if (hasAnnouncedReady || isCleaningUp) return;
    watchdog = setTimeout(async () => {
      if (hasAnnouncedReady || isCleaningUp) return;
      const state = await getClientStateWithTimeout(client);
      startupState.lastState = state;
      startupState.lastPageUrl = await getPageUrlSafe(client.pupPage);
      const elapsed = Date.now() - startupState.startedAt;

      if (elapsed > MAX_READY_TIMEOUT_MS) {
        await cleanupFailedClient({ reason: `⚠️ Session failed to reach READY state within ${MAX_READY_TIMEOUT_MS / 1000}s. Tearing down.` });
        return;
      }
      if (startupState.qrSeenAt && !startupState.authenticatedAt && !startupState.readyAt) {
        startupLog("QR is available and awaiting scan; keeping session alive.", null, "warn");
      } else if (startupState.authenticatedAt && !startupState.readyAt) {
        startupLog("Authenticated event received but READY has not fired yet; keeping session alive.", null, "warn");
      } else if ((!state || state === "INITIALIZING" || state === "OFFLINE") && elapsed > 60000) {
        await cleanupFailedClient({ reason: "⚠️ Handshake hang detected while INITIALIZING. Call /web-start/:id to try again." });
        return;
      }
      runWatchdogCheck();
    }, 30000);
    watchdog.unref?.();
  };

  runWatchdogCheck();
  startupLog(`Starting session initialization (saved auth ${fs.existsSync(sessionPath) ? "found" : "not found"})`);
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
    postWebhook({ event: "session", session: sessionId, type: "ready", state: "READY" });
    if (resumeUnreadReplaySessions.has(sessionId)) {
      resumeUnreadReplaySessions.delete(sessionId);
      try {
        await postLatestUnreadMessagesAfterResume();
      } catch (error) {
        console.error(`[${sessionId}] Resume unread replay failed:`, error.message);
      }
    }
  });

  client.on("change_state", (state) => {
    startupState.lastState = state || null;
    startupLog(`State changed to ${state || "null"}`);
    postWebhook({ event: "session", session: sessionId, type: "state_change", state: state || null });
  });

  client.on("loading_screen", (percent, message) => {
    startupState.lastLoadingPercent = percent ?? null;
    startupLog(`Loading screen ${percent ?? "?"}%${message ? `: ${String(message).trim()}` : ""}`);
  });

  client.on("authenticated", () => {
    if (hasAnnouncedAuthenticated) return;
    hasAnnouncedAuthenticated = true;
    startupState.authenticatedAt = Date.now();
    startupLog("Authenticated event received");
    postWebhook({ event: "session", session: sessionId, type: "authenticated" });
  });

  client.on("auth_failure", (message) => {
    startupLog("Auth failure", message || null, "warn");
    postWebhook({ event: "session", session: sessionId, type: "auth_failure", error: message || null });
  });

  client.on("disconnected", (reason) => {
    clearTimeout(watchdog);
    stopStartupDiagnosticsLoop();
    removeClientIfCurrent(sessionId, client);
    startupLog("Disconnected event received", reason || null, "warn");
    postWebhook({ event: "session", session: sessionId, type: "disconnected", reason: reason || null });
  });

  const recentReactionKeys = new Map();
  const reactionDedupWindowMs = 10 * 60 * 1000;
  const contactInfoCache = new Map();
  const contactInfoCacheTtlMs = 10 * 60 * 1000;

  async function getContactPhoneNumber(contact, fromId) {
    if (!contact) return null;
    if (contact.id?.server === "c.us") return contact.id.user;

    const lid = contact.id?.server === "lid" ? contact.id.user : null;
    const fromLid = String(fromId).endsWith("@lid") ? String(fromId).split("@")[0] : null;
    if (lid || fromLid) console.log(`[DEBUG-LID] Resolving LID: from=${fromLid}, contact=${lid}`);

    for (const candidate of [contact.number, contact.phoneNumber]) {
      const parsed = normalizePhoneNumber(candidate);
      if (parsed && parsed !== lid && parsed !== fromLid) {
        if (lid || fromLid) console.log(`[DEBUG-LID] Found number in field: ${parsed}`);
        return parsed;
      }
    }

    try {
      const parsed = normalizePhoneNumber(await contact.getFormattedNumber());
      if (parsed && parsed !== lid && parsed !== fromLid) {
        if (lid || fromLid) console.log(`[DEBUG-LID] Found number in formatted: ${parsed}`);
        return parsed;
      }
    } catch (error) {
      if (lid || fromLid) console.log(`[DEBUG-LID] getFormattedNumber failed: ${error.message}`);
    }

    if (lid || fromLid) console.log("[DEBUG-LID] No real phone number found for LID");
    return null;
  }

  async function resolveContactInfo(from, fallbackNotifyName = null) {
    const fallbackName = typeof fallbackNotifyName === "string" && fallbackNotifyName.trim() ? fallbackNotifyName.trim() : null;
    if (typeof from !== "string" || !from.trim()) return { notifyName: fallbackName, phoneNumber: null };

    const contactId = from.trim();
    const now = Date.now();
    const cached = contactInfoCache.get(contactId);
    if (cached && now - cached.at <= contactInfoCacheTtlMs) {
      return { notifyName: fallbackName || cached.notifyName, phoneNumber: cached.phoneNumber || null };
    }

    let timer;
    try {
      const result = await Promise.race([
        (async () => {
          const contact = await client.getContactById(contactId);
          const notifyName = fallbackName || contact?.pushname || contact?.name || contact?.shortName || contact?.formattedName || null;
          const phoneNumber = await getContactPhoneNumber(contact, contactId);
          return { notifyName, phoneNumber: phoneNumber || null };
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Resolution timeout")), 10000);
          timer.unref?.();
        }),
      ]);
      contactInfoCache.set(contactId, { ...result, at: now });
      return result;
    } catch (error) {
      if (error.message !== "Resolution timeout") console.error(`[${sessionId}] Contact resolution failed:`, error.message);
      const fallbackResolved = { notifyName: fallbackName, phoneNumber: null };
      contactInfoCache.set(contactId, { ...fallbackResolved, at: now });
      return fallbackResolved;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function buildContactPayload(contactId, contactInfo) {
    const identity = classifySerializedId(contactId);
    return {
      id: contactId || null,
      idType: identity.idType,
      notifyName: contactInfo.notifyName || null,
      phoneNumber: contactInfo.phoneNumber || null,
    };
  }

  function emitReactionWebhook(payload, meta = {}) {
    const key = [payload.session || "", meta.fromMe ? "1" : "0", payload.from || "", payload.body || "", meta.msgId || "", meta.timestamp || "", meta.orphan ? "1" : "0"].join("|");
    const now = Date.now();
    for (const [cachedKey, seenAt] of recentReactionKeys) {
      if (now - seenAt > reactionDedupWindowMs) recentReactionKeys.delete(cachedKey);
    }
    if (recentReactionKeys.has(key)) return;
    recentReactionKeys.set(key, now);

    const fromIdentity = classifySerializedId(payload.from);
    postWebhook({
      event: "message",
      session: payload.session || sessionId,
      from: payload.from || null,
      fromType: fromIdentity.idType,
      body: payload.body || "",
      type: "reaction",
      notifyName: payload.notifyName || null,
      phoneNumber: payload.phoneNumber || null,
      contact: buildContactPayload(payload.from, {
        notifyName: payload.notifyName || null,
        phoneNumber: payload.phoneNumber || null,
      }),
    });
  }

  async function buildMessageWebhookPayload(msg, extraPayload = {}) {
    if (msg.from === "status@broadcast") return;
    if (msg.type === "reaction") return;
    if (IGNORED_SYSTEM_MESSAGE_TYPES.has(msg.type)) return;

    const contactId = msg.author || msg.from;
    const contactInfo = await resolveContactInfo(contactId, msg._data?.notifyName);
    const fromIdentity = classifySerializedId(msg.from);
    const resolvedIdentity = classifySerializedId(contactId);

    const payload = {
      event: "message",
      session: sessionId,
      messageId: msg.id?._serialized || null,
      from: msg.from,
      fromType: fromIdentity.idType,
      resolvedFrom: contactId,
      resolvedFromType: resolvedIdentity.idType,
      body: msg.body,
      type: msg.type,
      notifyName: contactInfo.notifyName,
      phoneNumber: contactInfo.phoneNumber,
      contact: buildContactPayload(contactId, contactInfo),
      _debug: { resolvedFrom: contactId, hasContact: !!contactInfo.phoneNumber },
      ...extraPayload,
    };

    const downloadableTypes = ["image", "video", "audio", "document", "ptt", "sticker"];
    if (msg.hasMedia && downloadableTypes.includes(msg.type)) {
      try {
        const media = await msg.downloadMedia();
        if (media && media.data) {
          const ext = media.mimetype?.split("/")[1]?.split(";")[0] || "bin";
          const fallbackName = `${msg.type}_${Date.now()}.${ext}`;
          const originalName = sanitizeFilename(msg._data?.filename || fallbackName, fallbackName);
          const safeFilename = `${Date.now()}_${originalName}`;
          const fullPath = resolveSafePath(FILES_DIR, safeFilename);
          fs.writeFileSync(fullPath, media.data, "base64");
          payload.media = { url: buildPublicFileUrl(safeFilename), mimetype: media.mimetype, filename: originalName };

          if (msg.type === "ptt" || msg.type === "audio") {
            try {
              const transcriptText = await transcribeAudio(fullPath);
              payload.body = transcriptText || "[Inaudible Audio]";
            } catch (transcriptionError) {
              console.error(`[${sessionId}] Transcription error:`, transcriptionError.message);
              payload.body = "[Transcription Failed]";
            }
          }
        }
      } catch (error) {
        console.error(`[${sessionId}] Media download error:`, error.message);
      }
    }

    return payload;
  }

  async function postLatestUnreadMessagesAfterResume() {
    const chats = await client.getChats();
    const unreadChats = chats.filter((chat) => Number(chat.unreadCount) > 0);
    startupLog(`Replaying latest unread messages from ${unreadChats.length} chats`);

    for (const chat of unreadChats) {
      try {
        const unreadCount = Math.max(1, Number(chat.unreadCount) || 1);
        const messages = await chat.fetchMessages({ fromMe: false, limit: Math.min(unreadCount + 20, 100) });
        const latestUnreadMessage = messages.slice().reverse().find((msg) => msg.from !== "status@broadcast" && msg.type !== "reaction" && !IGNORED_SYSTEM_MESSAGE_TYPES.has(msg.type));
        if (!latestUnreadMessage) continue;
        const payload = await buildMessageWebhookPayload(latestUnreadMessage, { replayedAfterResume: true, unreadCount });
        if (payload) postWebhook(payload);
      } catch (error) {
        console.error(`[${sessionId}] Failed unread replay for ${chat.id?._serialized || "unknown chat"}:`, error.message);
      }
    }
  }

  client.on("message", async (msg) => {
    try {
      const payload = await buildMessageWebhookPayload(msg);
      if (payload) postWebhook(payload);
    } catch (error) {
      console.error(`[${sessionId}] Message handler error:`, error.message);
    }
  });

  client.on("message_reaction", async (reaction) => {
    const selfWid = client.info?.wid?._serialized || null;
    const fromMe = Boolean(reaction.fromMe || (selfWid && reaction.senderId === selfWid));
    const from = reaction.senderId || reaction.id?.participant || reaction.id?.remote || null;
    const contactInfo = await resolveContactInfo(from);
    emitReactionWebhook(
      { session: sessionId, from, body: reaction.reaction || "", notifyName: contactInfo.notifyName, phoneNumber: contactInfo.phoneNumber },
      { fromMe, msgId: reaction.msgId?._serialized || reaction.msgId || null, orphan: Boolean(reaction.orphan), timestamp: reaction.timestamp || null },
    );
  });

  client.on("message_create", async (msg) => {
    if (msg.type !== "reaction") return;
    const data = msg._data || {};
    const emoji = msg.body || data.reaction || "";
    const from = msg.author || msg.from || data.author?._serialized || data.from?._serialized || null;
    const contactInfo = await resolveContactInfo(from, msg._data?.notifyName);
    const parentMsgId = data.reactionParentKey?._serialized || data.parentMsgKey?._serialized || data.msgId?._serialized || data.msgId || null;
    emitReactionWebhook(
      { session: sessionId, from, body: emoji, notifyName: contactInfo.notifyName, phoneNumber: contactInfo.phoneNumber },
      { fromMe: Boolean(msg.fromMe), msgId: parentMsgId || msg.id?._serialized || null, orphan: Boolean(data.orphan), timestamp: msg.timestamp || data.t || null },
    );
  });

  startupLog("Calling client.initialize()");
  const initPromise = client.initialize();
  initPromise.catch((error) => cleanupFailedClient({ reason: "Init error", error }));
  initPromise.then(() => startupLog("client.initialize() promise resolved")).catch(() => {});

  return true;
}

async function stopSession(sessionId, options = {}) {
  const { logout = false } = options;
  const client = clients[sessionId];
  if (!client) return false;

  if (logout) resumeUnreadReplaySessions.delete(sessionId);
  else resumeUnreadReplaySessions.add(sessionId);

  try {
    if (logout) await client.logout();
    else await client.destroy();
  } catch (error) {
    console.error(`[${sessionId}] Failed to stop cleanly, forcing destroy:`, error.message);
    try {
      await client.destroy();
    } catch (destroyError) {
      console.error(`[${sessionId}] Failed to destroy client:`, destroyError.message);
    }
  }

  removeClientIfCurrent(sessionId, client);
  return true;
}

function getSession(sessionId) {
  return clients[sessionId];
}

function getQrCode(sessionId) {
  return qrCodes[sessionId];
}

async function getSessionStats() {
  const stats = {};
  for (const id in clients) {
    const state = await getClientStateWithTimeout(clients[id]);
    stats[id] = state || "INITIALIZING";
  }
  return stats;
}

async function buildRecipientCandidates(client, to) {
  const raw = String(to || "").trim();
  const explicitId = raw.includes("@") ? raw : null;
  let numeric = null;

  if (explicitId) {
    const [user, server] = explicitId.split("@");
    if (/^\d+$/.test(user || "") && ["c.us", "s.whatsapp.net", "lid"].includes(server)) numeric = user;
  } else {
    const digits = raw.replace(/\D/g, "");
    numeric = digits || null;
  }

  const candidates = [];
  if (numeric) {
    const numberId = await client.getNumberId(numeric).catch(() => null);
    const resolvedId = numberId?._serialized || (numberId?.user && numberId?.server ? `${numberId.user}@${numberId.server}` : null);
    if (resolvedId) candidates.push(resolvedId);
  }

  if (explicitId) candidates.push(explicitId);
  else if (numeric) candidates.push(`${numeric}@c.us`);

  if (numeric) {
    candidates.push(`${numeric}@c.us`);
    candidates.push(`${numeric}@lid`);
  }

  return [...new Set(candidates)];
}

function isRetryableDestinationError(error) {
  const message = String(error?.message || "");
  return /lid is missing in chat table/i.test(message) || /cannot read properties of undefined \(reading 'getchat'\)/i.test(message);
}

async function sendWithRecipientFallback(client, to, sendFn, options = {}) {
  const candidates = await buildRecipientCandidates(client, to);
  if (!candidates.length) throw new Error("Invalid destination");

  let lastError = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const chatId = candidates[i];
    if (options.messageRe && !quotedMessageMatchesCandidate(options.messageRe, chatId)) {
      lastError = new Error("Reply message does not belong to destination");
      continue;
    }

    try {
      await sendFn(chatId);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableDestinationError(error) || i === candidates.length - 1) throw error;
    }
  }

  throw lastError || new Error("Failed to resolve destination");
}

async function sendMessage(sessionId, to, text, options = {}) {
  const client = getSession(sessionId);
  if (!client) throw new Error("Session not active");
  const sendOptions = options.messageRe ? { quotedMessageId: options.messageRe } : {};
  await sendWithRecipientFallback(
    client,
    to,
    async (chatId) => client.sendMessage(chatId, text, sendOptions),
    { messageRe: options.messageRe },
  );
  return true;
}

async function sendFile(sessionId, to, fileBuffer, contentType, inferredName, caption, options = {}) {
  const client = getSession(sessionId);
  if (!client) throw new Error("Session not active");
  const media = new MessageMedia(contentType, fileBuffer.toString("base64"), inferredName);
  const safeCaption = typeof caption === "string" ? caption : "";

  await sendWithRecipientFallback(
    client,
    to,
    async (chatId) => client.sendMessage(chatId, media, {
      sendMediaAsDocument: true,
      caption: safeCaption,
      ...(options.messageRe ? { quotedMessageId: options.messageRe } : {}),
    }),
    { messageRe: options.messageRe },
  );
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
