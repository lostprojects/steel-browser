import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = { target: "http://127.0.0.1:3000", changeOrigin: true };

export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // The API sets its HttpOnly cookie and removes the key before Vite serves
      // the UI. DOMAIN=localhost:5173 gives REST, views and sockets one origin.
      "/ui/": {
        ...api,
        bypass: (request) =>
          new URL(request.url ?? "/", "http://localhost").searchParams.has("apiKey")
            ? undefined
            : request.url,
      },
      "/v1": { ...api, ws: true },
      "/health": api,
      "/documentation": api,
      "/mcp": api,
      "/downloads": api,
    },
  },
});
