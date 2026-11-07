#!/bin/sh
set -eu
if [ "${STEEL_ROLE:-standalone}" != "gateway" ] && [ "${STEEL_ROLE:-standalone}" != "executor" ]; then
    "${CHROME_EXECUTABLE_PATH:-/usr/bin/google-chrome-stable}" --version
fi
# Each session starts and stops its own Xvfb and VNC processes.
exec /usr/local/bin/node ./api/build/start.js
