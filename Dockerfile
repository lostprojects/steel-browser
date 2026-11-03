ARG NODE_VERSION=22.23.4

FROM node:${NODE_VERSION} AS base

WORKDIR /app

ENV NODE_ENV="production" \
    PUPPETEER_CACHE_DIR=/app/.cache \
    CHROME_BIN=/usr/bin/google-chrome-stable \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    CHROME_EXECUTABLE_PATH=/app/api/chrome-launcher.sh

LABEL org.opencontainers.image.source="https://github.com/lostprojects/steel-browser"

# Stage 1: Build UI
FROM node:${NODE_VERSION} AS ui-build

WORKDIR /app

# Copy root workspace files for UI build
COPY --link package.json package-lock.json ./
COPY --link ui/ ./ui/

# Install UI dependencies and build with correct base path
RUN npm ci --include=dev -w ui --ignore-scripts
RUN VITE_API_URL="" VITE_WS_URL="" npm run build -w ui -- --base=/ui

# Stage 2: Build API
FROM base AS api-build

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential \
    pkg-config \
    python-is-python3 \
    xvfb

# Copy root workspace files for API build
COPY --link package.json package-lock.json ./

# Remove or override the prepare script to avoid husky in Docker
RUN npm pkg set scripts.prepare="echo skip husky"

COPY --link api/ ./api/

# Install dependencies for API
RUN npm ci --include=dev --workspace=api

# Install dependencies for recorder extension separately
RUN cd api/extensions/recorder && npm ci --include=dev && cd -

# Build the API package
RUN npm run build -w api

# Build the recorder extension
RUN cd api/extensions/recorder && \
    npm run build && \
    cd -

# Prune dev dependencies
RUN npm prune --omit=dev -w api
RUN cd api/extensions/recorder && npm prune --omit=dev && cd -

# Stage 3: Production
FROM base AS production

# Install production dependencies
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -yq --no-install-recommends \
    wget \
    nginx \
    gnupg \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    xvfb \
    curl \
    unzip \
    dbus \
    dbus-x11 \
    procps \
    tini \
    x11-xserver-utils \
    x11vnc novnc xdotool ffmpeg util-linux \
    python3 python3-venv \
    libgl1-mesa-dri libglx-mesa0 fonts-liberation fonts-noto-color-emoji

RUN python3 -m venv /opt/browser-fetch && /opt/browser-fetch/bin/pip install --no-cache-dir curl_cffi==0.16.3

# Exact stable package; missing archived packages must fail the build.
ARG CHROME_VERSION=156.0.8078.79-1
ARG CHROME_SHA256=be1a1e161419f5c8272432f6860912550d8e29985e925913fa800493a0d0c955
RUN curl --fail --location --retry 3 \
    "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb" \
    -o /tmp/chrome.deb \
    || { echo "Pinned Chrome unavailable: bump CHROME_VERSION and CHROME_SHA256." >&2; exit 1; }
RUN echo "${CHROME_SHA256}  /tmp/chrome.deb" | sha256sum --check - \
    && apt-get update && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && test "$(dpkg-query -W -f='${Version}' google-chrome-stable)" = "${CHROME_VERSION}" \
    && rm -f /tmp/chrome.deb && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /etc/chromium/policies/managed /etc/opt/chrome/policies/managed \
    && echo '{"URLBlocklist":["file://*"]}' \
    | tee /etc/chromium/policies/managed/00_policy.json > /etc/opt/chrome/policies/managed/00_policy.json

RUN mkdir -p /files

# Copy the built API from api-build stage
COPY --from=api-build /app /app

# Copy the built UI from ui-build stage into the API container
COPY --from=ui-build /app/ui/dist /app/ui/dist

# Copy entrypoint script
COPY --chmod=755 api/entrypoint.sh api/chrome-launcher.sh /app/api/

EXPOSE 3000 9223

ENV HOST_IP=localhost \
    DBUS_SESSION_BUS_ADDRESS=autolaunch:

# Tini runs as PID 1 to forward signals and reap zombies (like compose `init: true`)
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/app/api/entrypoint.sh"]
