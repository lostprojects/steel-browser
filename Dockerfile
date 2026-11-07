ARG NODE_VERSION=22.23.4
ARG STEEL_IMAGE=browser

FROM node:${NODE_VERSION}-bookworm-slim AS base

WORKDIR /app

ENV NODE_ENV="production" LANG=C.UTF-8 LC_ALL=C.UTF-8

LABEL org.opencontainers.image.source="https://github.com/lostprojects/toolstack"

# Stage 1: Build UI
FROM base AS ui-build

WORKDIR /app

# Copy root workspace files for UI build
COPY --link package.json package-lock.json ./
COPY --link ui/ ./ui/

# Install UI dependencies and build with correct base path
RUN npm ci --include=dev -w ui --ignore-scripts
RUN VITE_API_URL="" VITE_WS_URL="" npm run build -w ui -- --base=/ui

# Stage 2: Build API
FROM base AS api-build

# Copy root workspace files for API build
COPY --link package.json package-lock.json ./

# Remove or override the prepare script to avoid husky in Docker
RUN npm pkg set scripts.prepare="echo skip husky"

COPY --link api/ ./api/

# Install dependencies for API
RUN npm ci --include=dev --workspace=api

# Build the API package
RUN npm run build -w api && npm run package:gateway -w api && node api/scripts/package-gateway.mjs --jobs

# Prune dev dependencies
RUN npm prune --omit=dev -w api && mkdir -p api/node_modules

# The gateway ships its entry point and OAuth runtime, without browser dependencies.
FROM base AS gateway

COPY --from=api-build /app/build/gateway-runtime /app/
COPY --link LICENSE /app/LICENSE
RUN node --input-type=module -e "await import('./gateway/server.js')"
ENV STEEL_ROLE=gateway
EXPOSE 3000
CMD ["node", "gateway/start.js"]

# Dedicated durable executor. This image needs no Chrome, X display or UI.
FROM base AS jobs
COPY --from=api-build /app/build/jobs-runtime /app/
COPY --link LICENSE /app/LICENSE
ENV STEEL_ROLE=executor NODE_OPTIONS="--max-old-space-size=256"
USER node
EXPOSE 8080
CMD ["node", "services/jobs/worker.js"]

# Browser worker and standalone runtime.
FROM base AS browser

ENV CHROME_EXECUTABLE_PATH=/app/api/chrome-launcher.sh

# Install production dependencies
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -yq --no-install-recommends \
    ca-certificates \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    xvfb \
    curl \
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

# Copy runtime files only; source, fixtures and build tools stay in the build stage.
COPY --from=api-build /app/package.json /app/package.json
COPY --from=api-build /app/node_modules /app/node_modules
COPY --from=api-build /app/api/package.json /app/api/package.json
COPY --from=api-build /app/api/node_modules /app/api/node_modules
COPY --from=api-build /app/api/build /app/api/build
COPY --link api/fetch.py /app/api/fetch.py
COPY --link LICENSE /app/LICENSE

# Copy the built UI from ui-build stage into the API container
COPY --from=ui-build /app/ui/dist /app/ui/dist

# Copy entrypoint script
COPY --chmod=755 api/entrypoint.sh api/chrome-launcher.sh /app/api/

EXPOSE 3000

ENV DBUS_SESSION_BUS_ADDRESS=autolaunch:

# Tini runs as PID 1 to forward signals and reap zombies (like compose `init: true`)
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/app/api/entrypoint.sh"]

# Railway passes declared build arguments from service variables. The default
# remains the browser image; gateway services set STEEL_IMAGE=gateway.
FROM ${STEEL_IMAGE} AS production
