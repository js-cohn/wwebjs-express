// Load environment variables from .env file
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const routes = require("./routes");
const { restorePersistedSessions } = require("./whatsapp");

const app = express();

// --- Global Middleware ---
// Parse incoming JSON requests.
app.use(express.json());

// --- Constants ---
const FILES_DIR = path.join(__dirname, "files");
const SESSIONS_DIR = path.join(__dirname, "sessions");
const PORT = process.env.PORT || 3000;
const RESTORE_DELAY_MS = 8000;

function isTransientBrowserError(errorLike) {
  const message = String(errorLike?.message || errorLike || "");
  return /Execution context was destroyed/i.test(message);
}

process.on("unhandledRejection", (reason) => {
  if (isTransientBrowserError(reason)) {
    console.error("Ignored transient browser rejection:", reason);
    return;
  }
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  if (isTransientBrowserError(error)) {
    console.error("Ignored transient browser exception:", error);
    return;
  }
  console.error("Uncaught exception:", error);
  process.exit(1);
});

// --- Directory Initialization ---
// Ensure persistent storage directories exist.
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR);
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// --- Static File Server ---
// Serve media files publicly from the 'files' directory.
// Caddy should be configured to handle public access control for this route.
app.use("/files", express.static(FILES_DIR));

// --- API Routes ---
// Mount the application routes from the routes.js module.
app.use(routes);

// --- Server Startup ---
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 API Service listening on port ${PORT}`),
);

// --- Session Restore ---
// Delay restore slightly after boot to reduce Chromium/Puppeteer startup races.
setTimeout(() => {
  try {
    const { restored } = restorePersistedSessions();
    if (restored.length > 0) {
      console.log(`♻️ Restoring persisted sessions: ${restored.join(", ")}`);
    }
  } catch (error) {
    console.error("Session restore failed at startup:", error);
  }
}, RESTORE_DELAY_MS);
