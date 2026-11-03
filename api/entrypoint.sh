#!/bin/sh
set -eu
"${CHROME_EXECUTABLE_PATH:-/usr/bin/google-chrome-stable}" --version
if [ "${1:-}" != "--no-nginx" ]; then
    nginx -c /app/api/nginx.conf
fi
# Each session starts and stops its own Xvfb and VNC processes.
exec /usr/local/bin/node ./api/build/index.js
