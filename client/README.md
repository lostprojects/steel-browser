# Optional Toolstack automation client

Most users connect through the hosted `/connect` page and approve their agent
in a browser. Files use ordinary browser downloads, with no local installation.

Use this optional client when a script needs an automatic, checksum-verified
local save or an agent only supports MCP stdio. It works from any project on
macOS, Windows or Linux and needs Node 22 or newer, with no package dependencies.
It does not need Python, Mosaic or a background service.

The client is a local release candidate and has not been published to the npm
registry. Check [deployment and release status](../TOOLSTACK-PLAN.md#current-baseline)
before using it with a hosted service.

## Install once

Install the release archive on the machine where files should be saved:

```sh
npm install --global ./toolstack-client-0.1.0.tgz
toolstack --help
```

For a source checkout, `npm pack` in this directory produces that archive. An
archive installation copies the package into npm's global location, so the
checkout can be removed afterwards. For source development, use
`node /absolute/path/to/client/cli.mjs` in place of `toolstack`.

Set `STEEL_URL` to the HTTPS service or gateway origin, and supply your personal
key through `STEEL_API_KEY` or `STEEL_AGENT_KEY`. Keys are not accepted as command
arguments and are not loaded from the current project's files.

The default destination is `Downloads` under your home folder. If your Downloads
folder has been relocated, set `STEEL_DOWNLOAD_DIR` once. `--out` selects another
directory for a command; relative paths are relative to the calling process.

## Connect an agent

```sh
toolstack mcp-config
```

This prints an MCP configuration with the installed Node and client paths.
Paste it into your agent's MCP settings and replace the key placeholder through
its secret configuration. The command does not print your existing key.
Generated paths work with spaces and Windows drive letters; no shell shim is
needed. Regenerate it if you move the Node installation or the client.

The output uses the common `mcpServers` JSON form. For a client with another
settings format, use the equivalent `command`, `args` and `env` fields.

`toolstack mcp` exposes the remote browser tools over local MCP stdio and adds
`browser_save`. Use the session and transfer IDs from `browser_download`, or
from a printed PDF, to save the file on this machine:

```json
{"session":"SESSION_UUID","transfer":"DELIVERY_UUID"}
```

`browser_save` accepts an optional `directory`, local `name` and `timeoutMs`.
It waits for a receiving delivery and returns the saved path, checksum and
acknowledgement state. Other browser commands retain the remote API's execution
and cancellation behavior. Closing the MCP input or cancelling a local save
aborts its I/O and removes its staging directory.

A direct remote `/mcp` connection returns browser download links. Automatic
publication to a filesystem uses this local bridge or the command-line receiver.
The destination is the machine running the bridge, including when an agent
itself runs in a VM or cloud environment.

For a manual download, open the delivery's `webUri` in a browser signed in to
Toolstack. The browser saves it using its normal download controls on macOS or
Windows, with no local client required. A ready published handoff remains
available after its browser session closes, until its thirty-minute expiry.
Browser downloads send no verified local receipt; expiry removes the remote
copy. Keep API keys out of links.

## Receive a file

These commands have the same arguments in Terminal and PowerShell:

```sh
toolstack receive --session SESSION_UUID --transfer DELIVERY_UUID
toolstack receive --session SESSION_UUID --file SESSION_FILE --out ./downloads
toolstack receive --session SESSION_UUID --source-url https://example.org/report.pdf
```

`--name` chooses a local filename. `--timeout` sets a budget in seconds, up to
one hour; the default is ten minutes. The command returns JSON for scripts.

The receiver streams into a private staging directory on the destination's
filesystem. It resumes interrupted HTTP responses with byte ranges and checks
the complete size and SHA-256 before publishing the file. Matching retries reuse
the saved bytes; differing content with the same name gets a checksum suffix.
Existing files, directories and symlinks are preserved.

Remote deletion happens only after local publication and file synchronization.
An offline acknowledgement returns `acknowledged: false` while retaining the
verified file. Retry the same delivery to resend its receipt without another
download. Close the browser session after collecting its files.

## Filesystem behavior

Publication uses a hard link on the same filesystem, which makes the completed
file visible without replacing another path. Normal local APFS and NTFS
destinations support this. A filesystem without hard links, such as exFAT,
produces an explicit error and retains the remote delivery for another
destination.

The completed file is flushed through Node's `FileHandle.sync()`. On macOS and
Linux, the client also synchronizes the destination directory where supported.
Node cannot perform that directory operation on Windows; the result reports
`directorySynced: false` there. Storage durability still depends on the OS and
device, as described in [Node's filesystem documentation](https://nodejs.org/api/fs.html#filehandlesync).

Names are made portable on every OS. The client replaces Windows reserved
characters, protects device names such as `CON` and removes trailing spaces or
periods, following [Microsoft's filename rules](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).

Normal failures and cancellation remove staging data. After an abrupt process
or machine termination, the next receive in that destination removes Toolstack
staging directories older than one minute whose owner process has ended.
It preserves staging directories belonging to live processes. This runs on
demand, with no cleanup daemon.

The bridge implements [MCP stdio and Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
for this Toolstack server. It refuses redirects and constructs authenticated file
requests from the configured origin, rather than following arbitrary links in
delivery metadata.

## JavaScript

```js
import { ToolstackClient } from "@toolstack/client";

const toolstack = new ToolstackClient(); // STEEL_URL and a key from the environment
const saved = await toolstack.receive({ session, transfer, directory: "./downloads" });
console.log(saved.path);
```

`receive()` also accepts `delivery` metadata, a session `file` or source `url`.
Pass an `AbortSignal` to cancel it. `saveBytes()` provides the same atomic local
publication for an existing byte buffer; it does not acknowledge a remote file.
