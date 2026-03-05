#!/bin/bash

# Remove stale Chromium singleton locks from persisted sessions.
# These files can survive container restarts and block browser startup.
echo "🧹 Cleaning up stale Chromium locks..."
if [ -d "/app/sessions" ]; then
    find /app/sessions -name "SingletonLock" -exec rm -f {} +
    find /app/sessions -name "SingletonCookie" -exec rm -f {} +
    find /app/sessions -name "SingletonSocket" -exec rm -f {} +
fi

# Launch the API process in the foreground as PID 1.
echo "🚀 Starting wwebjs-express..."
exec node index.js
