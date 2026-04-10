// Load environment variables from .env file
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const routes = require("./routes");

const app = express();
const configuredTrustProxyHops = Number(process.env.TRUST_PROXY_HOPS);
const trustProxyHops = Number.isFinite(configuredTrustProxyHops)
  ? Math.max(0, Math.floor(configuredTrustProxyHops))
  : 1;

// This app is intended to sit behind Caddy. Trust one proxy hop by default so
// req.ip reflects the original client and app-level rate limits work correctly.
app.set("trust proxy", trustProxyHops);

// --- Global Middleware ---
// Parse incoming JSON requests.
app.use(express.json());

// --- Constants ---
const FILES_DIR = path.join(__dirname, "files");
const SESSIONS_DIR = path.join(__dirname, "sessions");
const PORT = process.env.PORT || 3000;

function terminateProcess(label, errorLike) {
  console.error(`${label}:`, errorLike);
  process.exit(1);
}

process.on("unhandledRejection", (reason) => {
  terminateProcess("Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  terminateProcess("Uncaught exception", error);
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
