FROM node:22-bookworm-slim

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

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./

RUN npm install

RUN cd node_modules/whisper-node/lib/whisper.cpp && make
RUN cd node_modules/whisper-node/lib/whisper.cpp/models \
    && ./download-ggml-model.sh tiny \
    && test -s ggml-tiny.bin

COPY . .

RUN chmod +x start.sh
ENTRYPOINT ["./start.sh"]
