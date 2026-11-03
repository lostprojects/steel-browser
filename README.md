# Steel Browser, Mosaic fork

A self-hosted remote browser on Railway for Mosaic's collector. Browserbase remains available as a fallback while this service develops. Railway compute plus Evomi residential traffic at about $1/GB costs a fraction of Browserbase's $10–12/GB for proxy traffic.

The browser uses a Linux desktop display and accepts a residential proxy and its timezone. Detection results are measured separately for each build.

This is a fork of [steel-dev/steel-browser](https://github.com/steel-dev/steel-browser). Upstream's README and guides are archived in [upstream-docs/](upstream-docs/), unchanged apart from links repaired for the new location.

## Status

The service runs up to three independent sessions, with named profiles on a Railway volume. It deletes throwaway profiles on release and reports why each session ended. Deployment comes from `deploy`; documentation pushes are skipped.

Phase 2 passed with pinned Google Chrome 156.0.8078.79, separate X displays and authenticated noVNC. The owner accepts replacing incomplete transport and fixture runs; 20 complete results on distinct exits passed the fingerprint checks. The quiet-mode candidate passed detector checks with full snapshots and native clicks. Route acceptance stopped within the residential budget, so phase 3 remains unaccepted and production has been restored to phase 2. `main` and `deploy` remain synchronized.

The earlier singleton build passed deviceandbrowserinfo.com's bot test and loaded all six collector routes in supervised measurements, including Anna's Archive in three of four attempts. Those measurements are retained in [STEALTH.md](STEALTH.md); phase 2 fingerprint checks passed, while phase 3 still needs repeated route measurements before claiming the same results.

## Documents

| Read | For |
|---|---|
| [USAGE.md](USAGE.md) | Connecting a client: the API key, Patchright, the sticky proxy and timezone |
| [DEPLOYMENT.md](DEPLOYMENT.md) | The Railway service, its variables and where the credentials live |
| [STEALTH.md](STEALTH.md) | What anti-bot systems detect, what was fixed, route results and the measuring tool |
| [FORK.md](FORK.md) | Every change from upstream, and how to take upstream fixes |
| [upstream-docs/](upstream-docs/) | Steel's own README, contributing guide, architecture, API and troubleshooting docs |

## Quick check

```bash
curl https://steel-browser-production-e8d5.up.railway.app/v1/health        # {"status":"ok"}, no key needed
python mosaic/stealth_check.py probe                                        # fingerprint and bot-test flags
python mosaic/stealth_check.py routes core                                  # the six collector routes
```

The measuring tool reads `STEEL_URL`, `STEEL_API_KEY` and the Evomi proxy URLs from `/Users/moi/nosync.nosync/-env/global.env`. Run the route check from a temporary directory: it saves failed pages to `./stealth-failures/`.

## Licence

Apache 2.0, as upstream. See [LICENSE](LICENSE).
