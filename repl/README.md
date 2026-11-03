# Commands example

This fetch-only example creates a session, opens example.com and prints an interactive snapshot. It clicks the first link when present, waits for command completion and releases its session in a `finally` block.

From the repository root, run:

```bash
npm ci
npm run commands -w repl
```

Set `STEEL_URL` for a remote service and `STEEL_API_KEY` to match its key. The default URL is `http://localhost:3000`; the script reads these values from the process environment.

Set `STEEL_MODE=quiet` to exercise native input on Linux. The default is `agent`, which also supports local development on macOS. Enable `ENABLE_COMMANDS_API=true` on the server; the root Compose setup already does so.

See [USAGE.md](../USAGE.md) for authentication and session options. The service publishes the command request schema at `/v1/sessions/<id>/commands/schema`.
