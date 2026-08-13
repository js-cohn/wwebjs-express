// --- Hotfix for whatsapp-web.js _serialized to $1 rename ---
(function applyWwebPatch() {
  const fs = require("fs");
  const path = require("path");
  const { execSync } = require("child_process");

  try {
    const baseFile = path.join(__dirname, "node_modules", "whatsapp-web.js", "src", "structures", "Base.js");
    if (fs.existsSync(baseFile)) {
      const content = fs.readFileSync(baseFile, "utf8");
      if (!content.includes("_normalizeId")) {
        console.log("🩹 Applying whatsapp-web.js _serialized patch...");
        const patchContent = `diff --git a/index.d.ts b/index.d.ts
index 8127770492b..b155be8391d 100644
--- a/index.d.ts
+++ b/index.d.ts
@@ -212,10 +212,7 @@ declare namespace WAWebJS {
         ): Promise<Message>;

         /** Send a reaction to a specific messageId */
-        sendReaction(
-            messageId: string,
-            reaction: string,
-        ): Promise<void>;
+        sendReaction(messageId: string, reaction: string): Promise<void>;

         /** Sends a channel admin invitation to a user, allowing them to become an admin of the channel */
         sendChannelAdminInvite(
diff --git a/src/Client.js b/src/Client.js
index a122a8f336b..62de5395407 100644
--- a/src/Client.js
+++ b/src/Client.js
@@ -1234,7 +1234,8 @@ class Client extends EventEmitter {
                             const parentMsgKey = reaction.reactionParentKey;
                             const timestamp = reaction.reactionTimestamp / 1000;
                             const sender = reaction.author ?? reaction.from;
-                            const senderUserJid = sender._serialized;
+                            const senderUserJid =
+                                sender._serialized || sender.$1;

                             return {
                                 ...reaction,
@@ -1262,14 +1263,15 @@ class Client extends EventEmitter {
                             const parentMsgKey = vote.pollUpdateParentKey;
                             const timestamp = vote.t / 1000;
                             const sender = vote.author ?? vote.from;
-                            const senderUserJid = sender._serialized;
+                            const senderUserJid =
+                                sender._serialized || sender.$1;

                             let parentMessage = Msg.get(
-                                parentMsgKey._serialized,
+                                parentMsgKey._serialized || parentMsgKey.$1,
                             );
                             if (!parentMessage) {
                                 const fetched = await Msg.getMessagesById([
-                                    parentMsgKey._serialized,
+                                    parentMsgKey._serialized || parentMsgKey.$1,
                                 ]);
                                 parentMessage = fetched?.messages?.[0] || null;
                             }
@@ -1898,7 +1900,7 @@ class Client extends EventEmitter {
                 .joinGroupViaInvite(inviteCode);
         }, inviteCode);

-        return res.gid._serialized;
+        return res.gid._serialized || res.gid.$1;
     }

     /**
@@ -2442,7 +2444,8 @@ class Client extends EventEmitter {
                         (participant.wid = window
                             .require('WAWebApiContact')
                             .getPhoneNumber(participant.wid));
-                    const participantId = participant.wid._serialized;
+                    const participantId =
+                        participant.wid._serialized || participant.wid.$1;
                     const statusCode = participant.error || 200;

                     if (autoSendInviteV4 && statusCode === 403) {
@@ -2458,7 +2461,8 @@ class Client extends EventEmitter {
                                     (await window
                                         .require('WAWebCollections')
                                         .Chat.find(participant.wid)),
-                                createGroupResult.wid._serialized,
+                                createGroupResult.wid._serialized ||
+                                    createGroupResult.wid.$1,
                                 createGroupResult.subject,
                                 participant.invite_code,
                                 participant.invite_code_exp,
@@ -2932,7 +2936,7 @@ class Client extends EventEmitter {
             let chatIds = window
                 .require('WAWebCollections')
                 .Blocklist.getModelsArray()
-                .map((a) => a.id._serialized);
+                .map((a) => a.id._serialized || a.id.$1);
             return Promise.all(
                 chatIds.map((id) => window.WWebJS.getContact(id)),
             );
@@ -2993,7 +2997,9 @@ class Client extends EventEmitter {
                 );
                 const chats = window
                     .require('WAWebCollections')
-                    .Chat.filter((e) => chatIds.includes(e.id._serialized));
+                    .Chat.filter((e) =>
+                        chatIds.includes(e.id._serialized || e.id.$1),
+                    );

                 let actions = labels.map((label) => ({
                     id: label.id,
@@ -3374,8 +3380,8 @@ class Client extends EventEmitter {
                         await window.WWebJS.enforceLidAndPnRetrieval(userId);

                     return {
-                        lid: lid?._serialized,
-                        pn: phone?._serialized,
+                        lid: lid?._serialized || lid?.$1,
+                        pn: phone?._serialized || phone?.$1,
                     };
                 }),
             );
@@ -3446,9 +3452,12 @@ class Client extends EventEmitter {

             if (!serialized) return null;

-            serialized.chatId = window
-                .require('WAWebJidToWid')
-                .userJidToUserWid(serialized.chatJid)._serialized;
+            serialized.chatId = (() => {
+                const _w = window
+                    .require('WAWebJidToWid')
+                    .userJidToUserWid(serialized.chatJid);
+                return _w._serialized || _w.$1;
+            })();
             delete serialized.chatJid;

             return serialized;
diff --git a/src/structures/Base.js b/src/structures/Base.js
index ed1d83c09e6..a22afdf817a 100644
--- a/src/structures/Base.js
+++ b/src/structures/Base.js
@@ -19,6 +19,20 @@ class Base {
     _patch(data) {
         return data;
     }
+
+    /**
+     * Normalizes a WhatsApp ID object so that \`_serialized\` is always defined.
+     * WhatsApp Web changed \`_serialized\` to \`$1\` in July 2026. This ensures
+     * backward compatibility so all downstream code can continue using \`_serialized\`.
+     * @param {object} id
+     * @returns {object}
+     */
+    static _normalizeId(id) {
+        if (id && id._serialized == null && id.$1 != null) {
+            return Object.assign({}, id, { _serialized: id.$1 });
+        }
+        return id;
+    }
 }

 module.exports = Base;
diff --git a/src/structures/Broadcast.js b/src/structures/Broadcast.js
index ce03dfaf5fc..f0bbb8ed330 100644
--- a/src/structures/Broadcast.js
+++ b/src/structures/Broadcast.js
@@ -19,7 +19,7 @@ class Broadcast extends Base {
          * ID that represents the chat
          * @type {object}
          */
-        this.id = data.id;
+        this.id = Base._normalizeId(data.id);

         /**
          * Unix timestamp of last status
diff --git a/src/structures/Channel.js b/src/structures/Channel.js
index cd3e08786fe..25181de6b86 100644
--- a/src/structures/Channel.js
+++ b/src/structures/Channel.js
@@ -29,7 +29,7 @@ class Channel extends Base {
          * ID that represents the channel
          * @type {ChannelId}
          */
-        this.id = data.id;
+        this.id = Base._normalizeId(data.id);

         /**
          * Title of the channel
diff --git a/src/structures/Chat.js b/src/structures/Chat.js
index 40211bf04d4..79624e34430 100644
--- a/src/structures/Chat.js
+++ b/src/structures/Chat.js
@@ -19,7 +19,7 @@ class Chat extends Base {
          * ID that represents the chat
          * @type {object}
          */
-        this.id = data.id;
+        this.id = Base._normalizeId(data.id);

         /**
          * Title of the chat
diff --git a/src/structures/ClientInfo.js b/src/structures/ClientInfo.js
index 8e273c16a8d..de3dece19d9 100644
--- a/src/structures/ClientInfo.js
+++ b/src/structures/ClientInfo.js
@@ -24,7 +24,7 @@ class ClientInfo extends Base {
          * Current user ID
          * @type {object}
          */
-        this.wid = data.wid;
+        this.wid = Base._normalizeId(data.wid);

         /**
          * @type {object}
diff --git a/src/structures/Contact.js b/src/structures/Contact.js
index 339fa5c9e51..b56c967aa94 100644
--- a/src/structures/Contact.js
+++ b/src/structures/Contact.js
@@ -26,7 +26,7 @@ class Contact extends Base {
          * ID that represents the contact
          * @type {ContactId}
          */
-        this.id = data.id;
+        this.id = Base._normalizeId(data.id);

         /**
          * Contact's phone number
diff --git a/src/structures/GroupChat.js b/src/structures/GroupChat.js
index 3cecc82845b..b9049d472cc 100644
--- a/src/structures/GroupChat.js
+++ b/src/structures/GroupChat.js
@@ -156,7 +156,7 @@ class GroupChat extends Chat {
                 };

                 for (let pWid of participantWids) {
-                    const pId = pWid._serialized;
+                    const pId = pWid._serialized || pWid.$1;
                     pWid =
                         pWid.server === 'lid'
                             ? window
@@ -170,7 +170,11 @@ class GroupChat extends Chat {
                         isInviteV4Sent: false,
                     };

-                    if (groupParticipants.some((p) => p._serialized === pId)) {
+                    if (
+                        groupParticipants.some(
+                            (p) => (p._serialized || p.$1) === pId,
+                        )
+                    ) {
                         participantData[pId].code = 409;
                         participantData[pId].message = errorCodes[409];
                         continue;
@@ -223,7 +227,7 @@ class GroupChat extends Chat {
                                 .require('WAWebChatSendMessages')
                                 .sendGroupInviteMessage(
                                     userChat,
-                                    group.id._serialized,
+                                    group.id._serialized || group.id.$1,
                                     groupName,
                                     rpcResult.inviteV4Code,
                                     rpcResult.inviteV4CodeExp,
@@ -274,10 +278,10 @@ class GroupChat extends Chat {

                             return (
                                 chat.groupMetadata.participants.get(
-                                    lid?._serialized,
+                                    lid?._serialized || lid?.$1,
                                 ) ||
                                 chat.groupMetadata.participants.get(
-                                    phone?._serialized,
+                                    phone?._serialized || phone?.$1,
                                 )
                             );
                         }),
@@ -312,10 +316,10 @@ class GroupChat extends Chat {

                           return (
                                 chat.groupMetadata.participants.get(
-                                    lid?._serialized,
+                                    lid?._serialized || lid?.$1,
                                 ) ||
                                 chat.groupMetadata.participants.get(
-                                    phone?._serialized,
+                                    phone?._serialized || phone?.$1,
                                 )
                             );
                         }),
@@ -350,10 +354,10 @@ class GroupChat extends Chat {

                           return (
                                 chat.groupMetadata.participants.get(
-                                    lid?._serialized,
+                                    lid?._serialized || lid?.$1,
                                 ) ||
                                 chat.groupMetadata.participants.get(
-                                    phone?._serialized,
+                                    phone?._serialized || phone?.$1,
                                 )
                             );
                         }),
diff --git a/src/structures/GroupNotification.js b/src/structures/GroupNotification.js
index a723639f4ef..61d597851aa 100644
--- a/src/structures/GroupNotification.js
+++ b/src/structures/GroupNotification.js
@@ -18,7 +18,7 @@ class GroupNotification extends Base {
          * ID that represents the groupNotification
          * @type {object}
          */
-        this.id = data.id;
+        this.id = Base._normalizeId(data.id);

         /**
          * Extra content
@@ -45,7 +45,7 @@ class GroupNotification extends Base {
          */
         this.chatId =
             typeof data.id.remote === 'object'
-                ? data.id.remote._serialized
+                ? data.id.remote._serialized || data.id.remote.$1
                 : data.id.remote;

         /**
@@ -54,7 +54,7 @@ class GroupNotification extends Base {
          */
         this.author =
             typeof data.author === 'object'
-                ? data.author._serialized
+                ? data.author._serialized || data.author.$1
                 : data.author;

         /**
diff --git a/src/structures/Message.js b/src/structures/Message.js
index 51e9062dbc0..ed7991352d7 100644
--- a/src/structures/Message.js
+++ b/src/structures/Message.js
@@ -35,7 +35,9 @@ class Message extends Base {
          * ID that represents the message
          * @type {object}
          */
-        this.id = data.id;
+        // Normalize id: WhatsApp Web changed _serialized to $1 in 2026-07 update.
+        // Keep _serialized always populated for backward compatibility.
+        this.id = Base._normalizeId(data.id);

         /**
          * ACK status for the message
@@ -75,7 +77,7 @@ class Message extends Base {
          */
         this.from =
             typeof data.from === 'object' && data.from !== null
-                ? data.from._serialized
+                ? data.from._serialized || data.from.$1
                 : data.from;

         /**
@@ -87,7 +89,7 @@ class Message extends Base {
          */
         this.to =
             typeof data.to === 'object' && data.to !== null
-                ? data.to._serialized
+                ? data.to._serialized || data.to.$1
                 : data.to;

         /**
@@ -96,7 +98,7 @@ class Message extends Base {
          */
         this.author =
             typeof data.author === 'object' && data.author !== null
-                ? data.author._serialized
+                ? data.author._serialized || data.author.$1
                 : data.author;

         /**
@@ -211,13 +213,13 @@ class Message extends Base {
                       groupName: data.inviteGrpName,
                       fromId:
                           typeof data.from === 'object' &&
-                          '_serialized' in data.from
-                              ? data.from._serialized
+                          (data.from._serialized || data.from.$1)
+                              ? data.from._serialized || data.from.$1
                               : data.from,
                       toId:
                           typeof data.to === 'object' &&
-                          '_serialized' in data.to
-                              ? data.to._serialized
+                          (data.to._serialized || data.to.$1)
+                              ? data.to._serialized || data.to.$1
                               : data.to,
                   }
                 : undefined;
diff --git a/src/util/Injected/Utils.js b/src/util/Injected/Utils.js
index dfa30a579de..b7e23bc7fe7 100644
--- a/src/util/Injected/Utils.js
+++ b/src/util/Injected/Utils.js
@@ -582,7 +582,7 @@ exports.LoadUtils = () => {

         return window
             .require('WAWebCollections')
-            .Msg.get(newMsgKey._serialized);
+            .Msg.get(newMsgKey._serialized || newMsgKey.$1);
     };

     window.WWebJS.editMessage = async (msg, content, options = {}) => {
@@ -625,7 +625,9 @@ exports.LoadUtils = () => {
         await window
             .require('WAWebSendMessageEditAction')
             .sendMessageEdit(msg, content, internalOptions);
-        return window.require('WAWebCollections').Msg.get(msg.id._serialized);
+        return window
+            .require('WAWebCollections')
+            .Msg.get(msg.id._serialized || msg.id.$1);
     };

     window.WWebJS.toStickerData = async (mediaInfo) => {
@@ -830,10 +832,16 @@ exports.LoadUtils = () => {

         if (typeof msg.id.remote === 'object') {
             msg.id = Object.assign({}, msg.id, {
-                remote: msg.id.remote._serialized,
+                remote: msg.id.remote._serialized || msg.id.remote.$1,
             });
         }

+        // WhatsApp Web changed _serialized to $1 in message IDs (2026-07 update).
+        // Normalize here so all downstream Node.js code can keep using _serialized.
+        if (msg.id && msg.id._serialized == null && msg.id.$1 != null) {
+            msg.id = Object.assign({}, msg.id, { _serialized: msg.id.$1 });
+        }
+
         delete msg.pendingAckUpdate;

         return msg;
@@ -953,7 +961,7 @@ exports.LoadUtils = () => {
             model.isGroup = true;
             const chatWid = window
                 .require('WAWebWidFactory')
-                .createWid(chat.id._serialized);
+                .createWid(chat.id._serialized || chat.id.$1);
             const groupMetadata =
                 window.require('WAWebCollections').GroupMetadata ||
                 window.require('WAWebCollections').WAWebGroupMetadataCollection;
@@ -981,16 +989,17 @@ exports.LoadUtils = () => {

         model.lastMessage = null;
         if (model.msgs && model.msgs.length) {
-            const lastMessage = chat.lastReceivedKey
+            const _lastReceivedKeyId = chat.lastReceivedKey
+                ? chat.lastReceivedKey._serialized || chat.lastReceivedKey.$1
+                : null;
+            const lastMessage = _lastReceivedKeyId
                 ? window
                       .require('WAWebCollections')
-                      .Msg.get(chat.lastReceivedKey._serialized) ||
+                      .Msg.get(_lastReceivedKeyId) ||
                   (
                       await window
                           .require('WAWebCollections')
-                          .Msg.getMessagesById([
-                              chat.lastReceivedKey._serialized,
-                          ])
+                          .Msg.getMessagesById([_lastReceivedKeyId])
                   )?.messages?.[0]
                 : null;
             lastMessage &&
@@ -1320,9 +1329,10 @@ exports.LoadUtils = () => {
     };

     window.WWebJS.rejectCall = async (peerJid, id) => {
-        let userId = window
+        const _meUser = window
             .require('WAWebUserPrefsMeUser')
-            .getMaybeMePnUser()._serialized;
+        .getMaybeMePnUser();
+        let userId = _meUser._serialized || _meUser.$1;

         const stanza = window.require('WAWap').wap(
             'call',
@@ -1632,9 +1642,12 @@ exports.LoadUtils = () => {
                                       .membershipRequestsActionRejectParticipantMixins
                                       ?.value.error;
                             return {
-                                requesterId: window
-                                    .require('WAWebWidFactory')
-                                    .createWid(p.jid)._serialized,
+                                requesterId: (() => {
+                                    const _w = window
+                                        .require('WAWebWidFactory')
+                                        .createWid(p.jid);
+                                    return _w._serialized || _w.$1;
+                                })(),
                                 ...(error
                                     ? {
                                           error: +error,
@@ -1651,11 +1664,15 @@ exports.LoadUtils = () => {
                     }
                 } else {
                     result.push({
-                        requesterId: window
-                            .require('WAWebJidToWid')
-                            .userJidToUserWid(
-                                participant.participantArgs[0].participantJid,
-                            )._serialized,
+                        requesterId: (() => {
+                            const _w = window
+                                .require('WAWebJidToWid')
+                                .userJidToUserWid(
+                                    participant.participantArgs[0]
+                                        .participantJid,
+                                );
+                            return _w._serialized || _w.$1;
+                        })(),
                         message: 'ServerStatusCodeError',
                     });
                 }
`;
        const tempPatchPath = "/tmp/wwebjs.patch";
        fs.writeFileSync(tempPatchPath, patchContent, "utf8");
        execSync(`patch -p1 -d node_modules/whatsapp-web.js < ${tempPatchPath}`, {
          cwd: __dirname,
          stdio: "inherit"
        });
        fs.unlinkSync(tempPatchPath);
        console.log("✅ Patch applied successfully.");
      }
    }
  } catch (err) {
    console.error("❌ Failed to apply patch:", err.message);
  }
})();

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
        "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html",
      strict: false,
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

    // 1. If the contact is already resolved to a phone number ID, use it immediately.
    if (contact.id?.server === "c.us") return contact.id.user;

    // 2. Identify the LID numeric parts we must avoid.
    const lid = contact.id?.server === "lid" ? contact.id.user : null;
    const fromLid = String(fromId).endsWith("@lid")
      ? String(fromId).split("@")[0]
      : null;

    if (lid || fromLid) {
      console.log(`[DEBUG-LID] Resolving LID: from=${fromLid}, contact=${lid}`);
    }

    // 3. Check fields that often contain the real phone number.
    // If a field is numeric and doesn't match the LID, it's our winner.
    const candidates = [contact.number, contact.phoneNumber];
    for (const c of candidates) {
      const parsed = normalizePhoneNumber(c);
      if (parsed && parsed !== lid && parsed !== fromLid) {
        if (lid || fromLid)
          console.log(`[DEBUG-LID] Found number in field: ${parsed}`);
        return parsed;
      }
    }

    // 4. Fallback to the formatted number (often "linked" in the background).
    try {
      const formatted = await contact.getFormattedNumber();
      const parsed = normalizePhoneNumber(formatted);
      if (parsed && parsed !== lid && parsed !== fromLid) {
        if (lid || fromLid)
          console.log(`[DEBUG-LID] Found number in formatted: ${parsed}`);
        return parsed;
      }
    } catch (e) {
      if (lid || fromLid)
        console.log(`[DEBUG-LID] getFormattedNumber failed: ${e.message}`);
    }

    if (lid || fromLid)
      console.log(`[DEBUG-LID] No real phone number found for LID`);
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
    const now = Date.now();
    const cached = contactInfoCache.get(contactId);

    if (cached && now - cached.at <= contactInfoCacheTtlMs) {
      return {
        notifyName: fallbackName || cached.notifyName,
        phoneNumber: cached.phoneNumber || null,
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
      const resolved = { notifyName, phoneNumber: phoneNumber || null };
      contactInfoCache.set(contactId, { ...resolved, at: now });
      return resolved;
    } catch (e) {
      if (e.message !== "Resolution timeout") {
        console.error(`[${sessionId}] Contact resolution failed:`, e.message);
      }
      const fallbackResolved = { notifyName: fallbackName, phoneNumber: null };
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

    if (msg.hasQuotedMsg) {
      let quotedId = msg._data?.quotedMsg?.id?._serialized || null;
      try {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg && quotedMsg.id) {
          quotedId = quotedMsg.id._serialized || quotedId;
        }
      } catch (quotedError) {
        console.warn(
          `[${sessionId}] Failed to fetch quoted message:`,
          quotedError.message,
        );
      }
      if (quotedId) {
        payload.messageRe = quotedId;
      }
    }

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
