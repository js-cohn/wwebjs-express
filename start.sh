#!/bin/bash

echo "🧹 Cleaning up stale Chromium locks..."
if [ -d "/app/sessions" ]; then
    find /app/sessions -name "SingletonLock" -exec rm -f {} +
    find /app/sessions -name "SingletonCookie" -exec rm -f {} +
    find /app/sessions -name "SingletonSocket" -exec rm -f {} +
fi

echo "🚀 Starting wwebjs-express..."
exec node index.js
