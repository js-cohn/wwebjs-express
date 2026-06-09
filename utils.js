const axios = require("axios");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const dns = require("dns").promises;
const net = require("net");

// --- Environment Variable Imports and Constants ---
const {
  DOMAIN,
  WEBHOOK_URL,
  WHISPER_MODEL,
  WHISPER_TIMEOUT_SECONDS,
  MAX_DOWNLOAD_MB,
  DOWNLOAD_TIMEOUT_SECONDS,
  MAX_DOWNLOAD_REDIRECTS,
} = process.env;

if (WEBHOOK_URL) {
  console.log(`🔗 Webhook relay configured to: ${WEBHOOK_URL}`);
} else {
  console.warn("⚠️ WEBHOOK_URL is not set. Events will not be forwarded.");
}

// --- File Download Configuration ---
const maxDownloadMb = Number(MAX_DOWNLOAD_MB) || 10;
const downloadTimeoutSeconds = Number(DOWNLOAD_TIMEOUT_SECONDS) || 15;
const configuredMaxRedirects = Number(MAX_DOWNLOAD_REDIRECTS);
const whisperModelName = WHISPER_MODEL || "base";
const configuredWhisperTimeoutSeconds = Number(WHISPER_TIMEOUT_SECONDS);
const minimumWhisperTimeoutSeconds = whisperModelName === "base" ? 480 : 90;
const whisperTimeoutSeconds =
  Number.isFinite(configuredWhisperTimeoutSeconds) &&
  configuredWhisperTimeoutSeconds > 0
    ? Math.max(configuredWhisperTimeoutSeconds, minimumWhisperTimeoutSeconds)
    : minimumWhisperTimeoutSeconds;
const maxDownloadSizeBytes = Math.max(
  1,
  Math.floor(maxDownloadMb * 1024 * 1024),
);
const fileDownloadTimeoutMs = Math.max(
  1000,
  Math.floor(downloadTimeoutSeconds * 1000),
);
const maxDownloadRedirects = Number.isFinite(configuredMaxRedirects)
  ? Math.max(0, Math.floor(configuredMaxRedirects))
  : 5;

// --- Whisper.cpp Configuration ---
const WHISPER_CPP_DIR = path.join(
  __dirname,
  "node_modules",
  "whisper-node",
  "lib",
  "whisper.cpp",
);
const WHISPER_CPP_MAIN = path.join(WHISPER_CPP_DIR, "main");
const WHISPER_MODELS_DIR = path.join(WHISPER_CPP_DIR, "models");
const WHISPER_MODEL_FILE_BY_NAME = {
  base: "ggml-base.bin",
  "base.en": "ggml-base.en.bin",
  small: "ggml-small.bin",
  "small.en": "ggml-small.en.bin",
  medium: "ggml-medium.bin",
  "medium.en": "ggml-medium.en.bin",
  "large-v1": "ggml-large-v1.bin",
  large: "ggml-large.bin",
};

/**
 * Normalizes a domain or URL to a consistent base URL format.
 * Ensures it has a scheme and removes trailing slashes.
 * @param {string} rawValue - The raw domain or URL string.
 * @returns {string|null} A normalized base URL (e.g., "https://example.com") or null if invalid.
 */
function normalizePublicBaseUrl(rawValue) {
  if (typeof rawValue !== "string") return null;
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  const firstToken = trimmed.split(/[,\s]+/).find(Boolean);
  if (!firstToken) return null;

  const withScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(firstToken)
    ? firstToken
    : `https://${firstToken}`;

  try {
    const parsed = new URL(withScheme);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
      return null;
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    return cleanPath ? `${parsed.origin}${cleanPath}` : parsed.origin;
  } catch {
    return null;
  }
}

const resolvedPublicBaseUrl = normalizePublicBaseUrl(DOMAIN);

/**
 * Constructs a publicly accessible URL for a file served by this application.
 * @param {string} filename - The name of the file.
 * @returns {string} The absolute or relative URL to the file.
 */
function buildPublicFileUrl(filename) {
  const safeName = encodeURIComponent(String(filename || ""));
  if (resolvedPublicBaseUrl) {
    return `${resolvedPublicBaseUrl}/files/${safeName}`;
  }
  return `/files/${safeName}`;
}

/**
 * Sends a payload to the configured webhook URL, if available.
 * @param {object} payload - The JSON payload to send.
 * @param {string} [errorPrefix="Webhook relay failed"] - A prefix for error logging.
 */
function postWebhook(payload, errorPrefix = "Webhook relay failed") {
  if (!WEBHOOK_URL) return;
  const eventDesc =
    payload.event === "message"
      ? `message (${payload.type})`
      : `${payload.event}.${payload.type || "unknown"}`;
  console.log(`📡 Sending webhook: ${eventDesc}`);
  axios
    .post(WEBHOOK_URL, payload)
    .catch((err) => console.error(`${errorPrefix}: ${err.message}`));
}

/**
 * Gets the absolute path to a whisper.cpp model file.
 * @param {string} modelName - The name of the model (e.g., "base").
 * @returns {string|null} The full path to the model file or null if not found.
 */
function getWhisperModelPath(modelName) {
  const modelFile = WHISPER_MODEL_FILE_BY_NAME[modelName];
  if (!modelFile) {
    return null;
  }
  return path.join(WHISPER_MODELS_DIR, modelFile);
}

/**
 * Executes the whisper.cpp binary to transcribe an audio file.
 * @param {string} filePath - The path to the audio file to transcribe.
 * @param {string} modelPath - The path to the whisper.cpp model to use.
 * @returns {Promise<{stdout: string, stderr: string}>} A promise that resolves with the process output.
 */
function runWhisperCpp(filePath, modelPath) {
  const timeoutMs = Math.max(1000, Math.floor(whisperTimeoutSeconds * 1000));
  return new Promise((resolve, reject) => {
    execFile(
      WHISPER_CPP_MAIN,
      ["-m", modelPath, "-f", filePath, "-l", "auto", "-otxt"],
      {
        cwd: WHISPER_CPP_DIR,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed) {
            return reject(
              new Error(
                `Whisper transcription timed out after ${whisperTimeoutSeconds}s`,
              ),
            );
          }
          const details = String(stderr || stdout || error.message).trim();
          return reject(new Error(details || "Whisper execution failed"));
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * Converts an audio file into the WAV format whisper.cpp expects.
 * @param {string} sourcePath - The original audio file path.
 * @returns {Promise<{tempDir: string, wavPath: string}>} Temporary directory and converted WAV path.
 */
function convertAudioToWhisperWav(sourcePath) {
  const timeoutMs = Math.max(1000, Math.floor(whisperTimeoutSeconds * 1000));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
  const wavPath = path.join(tempDir, "input.wav");

  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-y", "-i", sourcePath, "-ar", "16000", "-ac", "1", wavPath],
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed) {
            fs.rmSync(tempDir, { recursive: true, force: true });
            return reject(
              new Error(
                `Audio conversion timed out after ${whisperTimeoutSeconds}s`,
              ),
            );
          }
          const details = String(stderr || stdout || error.message).trim();
          fs.rmSync(tempDir, { recursive: true, force: true });
          return reject(new Error(details || "Audio conversion failed"));
        }
        resolve({ tempDir, wavPath });
      },
    );
  });
}

/**
 * Transcribes an audio file using whisper.cpp.
 * @param {string} filePath - Path to the audio file.
 * @returns {Promise<string>} A promise that resolves with the transcription text.
 */
async function transcribeAudio(filePath) {
  const modelName = whisperModelName;
  const modelPath = getWhisperModelPath(modelName);
  if (!modelPath) {
    throw new Error(`Unsupported Whisper model: ${modelName}`);
  }
  if (!fs.existsSync(WHISPER_CPP_MAIN)) {
    throw new Error(`Whisper binary not found: ${WHISPER_CPP_MAIN}`);
  }
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Whisper model not found: ${modelPath}`);
  }

  const { tempDir, wavPath } = await convertAudioToWhisperWav(filePath);
  const txtOutputPath = `${wavPath}.txt`;
  try {
    await runWhisperCpp(wavPath, modelPath);
    if (!fs.existsSync(txtOutputPath)) {
      return ""; // No output file means transcription was likely silent.
    }
    return fs.readFileSync(txtOutputPath, "utf8").trim();
  } finally {
    // Clean up the generated text file.
    if (fs.existsSync(txtOutputPath)) {
      fs.unlinkSync(txtOutputPath);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Cleans a filename by removing unsafe characters and truncating it.
 * @param {string} name - The original filename.
 * @param {string} [fallback="file.bin"] - A fallback name if the sanitized name is empty.
 * @returns {string} The sanitized filename.
 */
function sanitizeFilename(name, fallback = "file.bin") {
  const base = path.basename(String(name || ""));
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return clean || fallback;
}

/**
 * Ensures a file path is safely within a specific base directory.
 * This prevents path traversal attacks (e.g., trying to access "../../../etc/passwd").
 * @param {string} baseDir - The directory that the file should be inside.
 * @param {string} filename - The name of the file.
 * @returns {string} The resolved, safe, absolute path.
 * @throws {Error} If the path is outside the base directory.
 */
function resolveSafePath(baseDir, filename) {
  const target = path.resolve(baseDir, filename);
  const root = `${path.resolve(baseDir)}${path.sep}`;
  if (!target.startsWith(root)) {
    throw new Error("Invalid file path: Traversal detected");
  }
  return target;
}

// --- SSRF Protection and Network Utilities ---

function isPrivateIPv4(ipAddress) {
  const parts = ipAddress.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true; // RFC1918, loopback, loopback
  if (a === 169 && b === 254) return true; // RFC3927
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598
  return false;
}

function isPrivateIPv6(ipAddress) {
  const ip = ipAddress.toLowerCase();
  if (ip === "::1" || ip === "::") return true; // Loopback
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // ULA
  // Link-local
  if (
    ip.startsWith("fe8") ||
    ip.startsWith("fe9") ||
    ip.startsWith("fea") ||
    ip.startsWith("feb")
  ) {
    return true;
  }
  return false;
}

/**
 * Checks if an IP address is in a private or reserved range.
 * @param {string} ipAddress - The IP address to check.
 * @returns {boolean} True if the IP is private.
 */
function isPrivateIpAddress(ipAddress) {
  const ip = ipAddress.toLowerCase();
  // Handle IPv4-mapped IPv6 addresses
  if (ip.startsWith("::ffff:")) {
    return isPrivateIpAddress(ip.slice(7));
  }
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true; // Default to private if IP is invalid
}

/**
 * Checks for hostnames that are likely to resolve to local services.
 * @param {string} hostname - The hostname to check.
 * @returns {boolean} True if the hostname is local.
 */
function isLocalHostname(hostname) {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return true;
  }
  // Single-label names (no dots) are often internal DNS names.
  if (!host.includes(".")) return true;
  return false;
}

/**
 * Pins outbound requests to a single validated IP address.
 * This avoids DNS rebinding between validation time and connect time.
 * @param {{address: string, family: 4|6}} selectedAddress - Validated IP.
 * @returns {(hostname: string, options: object, callback: Function) => void}
 */
function buildPinnedLookup(selectedAddress) {
  return (_hostname, _options, callback) =>
    callback(null, selectedAddress.address, selectedAddress.family);
}

/**
 * Builds request options that force axios/node to reuse the validated DNS result.
 * @param {{lookup: ReturnType<typeof buildPinnedLookup>, family: 4|6}|null} pin
 * @returns {{httpAgent?: import('http').Agent, httpsAgent?: import('https').Agent, family?: 4|6}}
 */
function buildPinnedRequestOptions(pin) {
  if (!pin) return {};
  return {
    httpAgent: new http.Agent({
      lookup: pin.lookup,
      family: pin.family,
      autoSelectFamily: false,
    }),
    httpsAgent: new https.Agent({
      lookup: pin.lookup,
      family: pin.family,
      autoSelectFamily: false,
    }),
    family: pin.family,
  };
}

/**
 * Validates a URL to ensure it is safe to download from.
 * This is a critical security function to prevent Server-Side Request Forgery (SSRF).
 * @param {string} rawUrl - The URL to validate.
 * @returns {Promise<{url: string, pin: {lookup: ReturnType<typeof buildPinnedLookup>, family: 4|6}|null}>}
 * The validated URL and optional DNS pinning for the eventual request.
 * @throws {Error} If the URL is invalid or points to a protected resource.
 */
async function assertSafeDownloadUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid file URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http/https URLs are allowed");
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  if (!hostname) throw new Error("Invalid file URL host");

  // 1. Check for obviously local hostnames.
  if (isLocalHostname(hostname)) {
    throw new Error("Local/internal hostnames are not allowed");
  }

  // 2. If it's an IP, check if it's in a private range.
  if (net.isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) {
      throw new Error("Private IP ranges are not allowed");
    }
    return { url: parsed.toString(), pin: null };
  }

  // 3. If it's a domain, resolve it and check all resulting IPs.
  const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!resolved.length) throw new Error("Unable to resolve file host");
  if (resolved.some((entry) => isPrivateIpAddress(entry.address))) {
    throw new Error("Resolved host is in a private IP range");
  }

  const selectedAddress =
    resolved.find((entry) => entry.family === 4) || resolved[0];
  return {
    url: parsed.toString(),
    pin: {
      lookup: buildPinnedLookup(selectedAddress),
      family: selectedAddress.family,
    },
  };
}

/**
 * Downloads a file from a URL, safely handling redirects.
 * Re-validates the URL at each redirect step to prevent redirect-based SSRF attacks.
 * @param {string} rawUrl - The initial URL to download from.
 * @returns {Promise<{response: import('axios').AxiosResponse, finalUrl: string}>} The download response and the final URL.
 */
async function downloadWithSafeRedirects(rawUrl) {
  let currentTarget = await assertSafeDownloadUrl(rawUrl);

  for (let hop = 0; hop <= maxDownloadRedirects; hop += 1) {
    const response = await axios.get(currentTarget.url, {
      responseType: "arraybuffer",
      timeout: fileDownloadTimeoutMs,
      maxContentLength: maxDownloadSizeBytes,
      maxBodyLength: maxDownloadSizeBytes,
      proxy: false,
      maxRedirects: 0, // We handle redirects manually.
      validateStatus: (status) =>
        (status >= 200 && status < 300) || (status >= 300 && status < 400),
      ...buildPinnedRequestOptions(currentTarget.pin),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location) {
        throw new Error("Redirect response missing location header");
      }
      if (hop === maxDownloadRedirects) {
        throw new Error("Too many redirects");
      }
      // Re-validate the new URL before following it.
      const redirectedUrl = new URL(location, currentTarget.url).toString();
      currentTarget = await assertSafeDownloadUrl(redirectedUrl);
      continue;
    }

    return { response, finalUrl: currentTarget.url };
  }

  throw new Error("Too many redirects");
}

/**
 * Classifies an error from the /send-file flow into a user-friendly message and status code.
 * @param {Error} error - The error that occurred.
 * @returns {{status: number, error: string}} The HTTP status code and error message.
 */
function classifySendFileError(error) {
  const message = error?.message || "Failed to send file";
  const clientErrorMessages = [
    "Invalid file URL",
    "Only http/https URLs are allowed",
    "Invalid file URL host",
    "Local/internal hostnames are not allowed",
    "Private IP ranges are not allowed",
    "Unable to resolve file host",
    "Resolved host is in a private IP range",
    "Redirect response missing location header",
    "Too many redirects",
    "Invalid file path: Traversal detected",
  ];

  if (message === "File exceeds maximum size") {
    return { status: 413, error: "File exceeds maximum size" };
  }

  if (message === "Session not active") {
    return { status: 404, error: "Session not active" };
  }

  if (clientErrorMessages.includes(message)) {
    return { status: 400, error: message };
  }

  if (message === "Invalid destination") {
    return { status: 400, error: "Invalid destination" };
  }

  if (axios.isAxiosError(error)) {
    if (error.code === "ECONNABORTED") {
      return { status: 504, error: "File download timed out" };
    }
    if (error.response?.status) {
      return { status: 400, error: "Failed to download file from URL" };
    }
    if (error.request || error.code) {
      return { status: 400, error: "Failed to download file from URL" };
    }
  }

  // For unknown errors, log the details and return a generic message.
  console.error("Unhandled /send-file error:", error);
  return { status: 500, error: "Failed to process file" };
}

module.exports = {
  maxDownloadSizeBytes,
  buildPublicFileUrl,
  postWebhook,
  transcribeAudio,
  sanitizeFilename,
  resolveSafePath,
  downloadWithSafeRedirects,
  classifySendFileError,
};
