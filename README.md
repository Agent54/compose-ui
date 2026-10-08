# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
deno run npm:sv@0.14.1 create --template minimal --types ts --add prettier eslint tailwindcss="plugins:typography,forms" sveltekit-adapter="adapter:static" devtools-json mcp="ide:opencode" --install deno .
```

## Developing

Install dependencies and start a local development server with Deno:

```sh
deno install --allow-scripts=npm:esbuild
deno task dev

# or start the server and open the app in a new browser tab
deno task dev -- --open
```

## Docker Compose

Run the UI in Docker:

```sh
docker compose up
```

For Docker Compose Watch:

```sh
docker compose watch
```

## Interactive shells

Container Shell actions and the header's VM Shell action open `/shell/index.html` in a new
browser tab. The terminal uses xterm.js with resize, search, Unicode, accessibility controls,
and optional WebGL rendering. Stopped containers request a start before opening Bash, with
`sh` as a fallback for images without Bash. Normal clicks attach to the last persistent dtach
session; Cmd-click or New session creates another. The header dropdown shows each session's
name/number, command and cwd. Closing a tab only detaches; Close session explicitly deletes it.
The server determines the current container state.

When the live shell backend is unavailable, the UI uses a clearly marked browser-local demo
backend with saved simulated sessions. Demo commands never run on the container or VM.

Below xterm, a native command textarea supports browser selection, caret movement, undo,
paste, shell syntax highlighting, and multiline editing. Enter sends to the attached PTY;
Shift+Enter adds a line. Use ↑/↓ or the History picker to recall commands without executing
them. The editor keeps its own IndexedDB history across reloads, shared across sessions for
the same target and separated between demo/live backends. There is no entry cap or automatic
pruning; available browser storage still applies. This history is separate from Bash history
and terminal scrollback. Tab completions and folder selection are planned in the handover.

Real shell access requires the session/PTY backend described in
[the shell agent handover](docs/shell-handover.md), which includes the engine comparison,
HTTP/WebSocket contract, and work for the Compose, launcher, smolvm, and worker agents.

## Building

To create the production static assets:

```sh
deno install --frozen --allow-scripts=npm:esbuild
deno task check
deno task build
```

The static adapter writes the complete site to `build/`, including `index.html` and
`_app/`. You can preview it with `deno task preview`. No Deno or Node server is needed
to serve the production files.

## CI and desktop release dependency

The [Static assets workflow](.github/workflows/static-assets.yml) runs on branch pushes,
pull requests, manual dispatch, and published GitHub releases (including prereleases).
It installs the frozen Deno lockfile, checks the app, builds it, and uploads a
`compose-ui-static` Actions artifact retained for 14 days.

Every successful push build on `int` also creates a GitHub prerelease tagged
`int-<run-number>-<short-commit-sha>` at the exact pushed commit, with the archives
and checksums attached in the same workflow run. These prereleases are not marked
as the latest stable release. Rerunning a workflow reuses its prerelease and replaces
the attached assets. The desktop application can pin one of these tags just like a
stable release tag.

Publishing a GitHub release builds the release's tagged commit and attaches:

- `compose-ui-static.tar.gz`
- `compose-ui-static.zip`
- `SHA256SUMS` (SHA-256 checksums for both archives)

Both archives contain the contents of `build/` directly at their root. They contain
only the static site, without source files, dependencies, or a server runtime, and
the same bundle can be used on all desktop platforms. Wait for the workflow to
finish before consuming a newly published release. Rerunning the release job
replaces assets with the same names. A tag push alone does not publish a release;
publish the release through GitHub or `gh release create` to trigger the upload.

In the desktop application's build, pin a release tag and download the bundle:

```sh
UI_VERSION=v0.1.0 # replace with a published release tag
gh release download "$UI_VERSION" --repo Agent54/compose-ui \
  --pattern 'compose-ui-static.*' --pattern SHA256SUMS --dir ui-download
cd ui-download
sha256sum --check SHA256SUMS # on macOS: shasum -a 256 --check SHA256SUMS
mkdir -p ../ui-assets
tar -xzf compose-ui-static.tar.gz -C ../ui-assets
```

Bundle `ui-assets/` into the desktop application and serve it through its local HTTP
server or webview asset protocol, with `index.html` as the entry point and correct
JavaScript/CSS MIME types. Keep the directory structure intact. Direct `file://`
loading is not the supported integration. The UI's configured Compose API server
must still be reachable from the desktop webview; the bundle does not include the
backend.

For an HTTP downloader, the tarball URL has the form
`https://github.com/Agent54/compose-ui/releases/download/<tag>/compose-ui-static.tar.gz`
(use the same path for `SHA256SUMS` or the ZIP). Authenticate downloads if the
repository is private.
