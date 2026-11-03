# Steel Browser, Mosaic fork

A self-hosted remote browser on Railway for Mosaic's collector. Browserbase remains available as a fallback while this service develops. Railway compute plus Evomi residential traffic at about $1/GB costs a fraction of Browserbase's $10–12/GB for proxy traffic.

The browser is tuned to look like an ordinary Linux desktop to anti-bot systems. It reports itself truthfully and consistently, leaves no automation traces, and goes out through a residential IP whose timezone it matches.

This is a fork of [steel-dev/steel-browser](https://github.com/steel-dev/steel-browser). Upstream's README and guides are archived in [upstream-docs/](upstream-docs/), unchanged apart from links repaired for the new location.

## Status

As of 3 November 2026, the browser passes deviceandbrowserinfo.com's bot test with no flags. All six Mosaic collector routes that need a residential IP load cleanly, Anna's Archive in 3 of 4 runs; its failures fall back to DDoS-Guard's manual check. [STEALTH.md](STEALTH.md) has the details.

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
