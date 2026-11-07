FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY ui/package.json ./ui/package.json
RUN npm ci --include=dev -w ui --ignore-scripts
COPY ui ./ui
RUN VITE_API_URL="" VITE_WS_URL="" npm run build -w ui -- --base=/ui

FROM caddy:2.10.2-alpine
ENV PORT=8080
COPY --from=build /app/ui/dist /srv/toolstack
COPY deployment/railway/web.Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
