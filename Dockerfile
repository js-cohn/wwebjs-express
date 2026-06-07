FROM node:22-bookworm-slim

# Install runtime and build dependencies:
# - chromium for whatsapp-web.js/puppeteer
# - ffmpeg for audio/media processing
# - toolchain for whisper.cpp compilation
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    chromium \
    fonts-freefont-ttf \
    ffmpeg \
    python3 \
    make \
    g++ \
    build-essential \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

RUN update-ca-certificates
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/

# Use system chromium instead of downloading a bundled browser.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./

# Install Node dependencies before app source for better layer caching.
RUN npm install

# Build whisper.cpp and pre-download the default base model.
# We strip '-mcpu=native' because it breaks multi-platform builds in GitHub Actions
RUN cd node_modules/whisper-node/lib/whisper.cpp && \
    sed -i 's/-mcpu=native//g' Makefile && \
    make -j$(nproc)

RUN cd node_modules/whisper-node/lib/whisper.cpp/models \
    && ./download-ggml-model.sh base \
    && test -s ggml-base.bin

COPY . .

RUN chmod +x start.sh
# start.sh performs lock cleanup and starts the API process.
ENTRYPOINT ["./start.sh"]
