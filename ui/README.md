# Toolstack dashboard

The dashboard at `/ui/` selects among live and recently ended sessions. It shows session metadata and permitted live views; agent-mode browser events are scoped to the selected session. Quiet sessions have no instrumentation stream, and protected profiles show metadata without a viewer.

## Development

Copy `api/.env.example` to `api/.env`, choose a local `STEEL_API_KEY` and keep `DOMAIN=localhost:5173`. From the repository root, run `npm run dev`.

Open `http://localhost:5173/ui/?apiKey=<key>` once. Vite forwards this authentication request to the API, which sets an HttpOnly cookie and redirects back without the key. Subsequent UI, REST and WebSocket requests share the same origin. The API runs on port 3000; Vite uses a fixed port 5173 and binds to loopback.

Compose and production serve the built UI directly through the API. Compose uses `http://localhost:3000/ui/`; production uses the configured HTTPS domain.

`VITE_API_URL` and `VITE_WS_URL` default to empty strings. Keep them empty for these supported setups; a different origin also requires deliberate authentication and service-origin configuration.

## API types

`src/client` is generated from the four session models used by `src/api.ts`. `api/openapi/schemas.json` contains only those models; the service keeps its complete API documentation at `/documentation`. Generate both after changing a schema:

```bash
npm run generate:openapi -w api
npm run generate-api -w ui
```

The pinned `npx` generator uses its own pinned TypeScript through `--prefix=/`. The running API provides route documentation at `/documentation`.

Run `npm run typecheck -w ui` and `npm run build -w ui` for local verification. React is the only UI runtime dependency. CSS variables live in `src/styles/tokens.css`; font files and their SIL Open Font licences remain in `src/fonts`.
