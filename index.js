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

// --- Directory Initialization ---
// Ensure persistent storage directories exist.
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR);
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// --- Session Restore ---
// Auto-restore persisted WhatsApp sessions so /web-start is not required
// after every container restart.
const { restored } = restorePersistedSessions();
if (restored.length > 0) {
  console.log(`♻️ Restoring persisted sessions: ${restored.join(", ")}`);
}

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
