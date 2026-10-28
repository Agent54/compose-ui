# Compose UI agent README

## Runtime context — read before debugging containers

This repository is the Compose UI for **Xe Computer**, managed by Xe Launcher.
It builds a static SvelteKit site. The production runtime and application gateway
live in the reference repository `../../darc-launcher`, not in this repository's
Vite dev server or the sibling `../workerd` directory.

The launcher integration is documented and implemented in:

- [Launcher README](../../darc-launcher/README.md), especially Compose and Building from source.
- [Workerd README](../../darc-launcher/workerd/README.md), especially Lifecycle and Development and verification.
- [ComposeServer.swift](../../darc-launcher/macos/Sources/macos/ComposeServer.swift): host Compose API process and its Docker connection.
- [WorkerdServer.swift](../../darc-launcher/macos/Sources/macos/WorkerdServer.swift): UI assets, listeners, and backend socket bindings.
- [RuntimeSocketPaths.swift](../../darc-launcher/macos/Sources/macos/RuntimeSocketPaths.swift) and [SmolVMSetup.swift](../../darc-launcher/macos/Sources/macos/SmolVMSetup.swift): actual socket paths, VM configuration, and mounts.

Read the relevant reference source when investigating integration behavior; these
paths and defaults describe the current launcher checkout and can change.

### How this UI is used

1. Xe Launcher supervises the host Compose API server, host Workerd, and the
   `xe-launcher` SmolVM, which runs Docker and the guest application router.
2. This repo's `build/` assets are bundled at
   `Contents/Resources/compose-ui` in the launcher app and served by host Workerd.
3. The UI uses versioned Compose API requests such as `/v1.24/stop/{project}`.
   An empty `serverUrl` means requests use the UI's origin. Workerd proxies these
   requests to the host Compose server over its Unix socket.
4. Compose runs on macOS and connects to Docker inside SmolVM through an exposed
   Unix socket. Project discovery and builds run on the host. The selected
   `compose_storage_path` folder is shared into the VM at `/stacks`; Compose
   translates host bind sources into their guest paths.
5. The UI and host Compose API remain available during VM recovery. Docker-dependent
   requests can return retryable 503 responses with runtime status.

The public UI is `http://compose-ui.localhost/` or
`https://compose-ui.localhost/` when standard ports 80/443 are selected. The fallback
ports are HTTP 5196 and HTTPS 5194. Discover the launcher's configured ports rather
than assuming which pair is active. Port 8094 is the private loopback management/API
listener, not the public UI or application origin.

### Use the launcher's runtime, not the shell's Docker context

Do not infer this app's Docker daemon from `docker context ls`, an unqualified
`docker ps`, Colima, Docker Desktop, or `/var/run/docker.sock` on the Mac. Those
can point to unrelated environments. The launcher explicitly clears inherited
Docker context/TLS settings and selects its own Docker socket.

Current host socket paths are:

- Compose API: `~/.xe/run/compose.sock`.
- SmolVM Docker API: `~/.xe/run/smol/sockets/docker.sock`.
- Guest application router: `~/.xe/run/smol/sockets/workerd.sock`.

`~/.xe/run` is a short symlink to
`~/Library/Application Support/dev.xe.computer`. Preserve this short spelling when
passing socket paths to processes; macOS Unix socket paths have a length limit.

For a read-only inspection of the launcher's environment, use an explicit target:

```sh
curl --unix-socket "$HOME/.xe/run/compose.sock" 'http://localhost/v1.24/ls?all=true'
env -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  -u DOCKER_API_VERSION docker --host "unix://$HOME/.xe/run/smol/sockets/docker.sock" ps
```

If that socket is unavailable or access is denied, report that specific limitation.
Do not substitute another Docker context as evidence about this runtime.

### Trace all sources of container startup

For stop/restart-loop issues, trace the UI action in `src/routes/+page.svelte` and
`src/lib/central/api.ts`, the Compose backend in `../../compose/server` and
`../../compose/pkg/compose`, and launcher Workerd's application startup behavior.

Docker restart policy, Compose watch, and startup on application requests are
separate mechanisms. In `../../darc-launcher/workerd`, `app-routing.js`,
`app-startup.js`, `tls-gateway.js`, and `service-startup.js` coordinate starting
uncreated, created, exited, or stopped applications when their URLs are requested.
An open application tab or client that keeps requesting its route can therefore
trigger another start after a successful Stop. Check this path before attributing
every subsequent start to Docker's restart policy. The optional
`compose_startup_services` launcher setting also schedules service starts; it is
empty by default. Do not claim any of these is the cause without tracing it.

### Local changes versus the bundled application

Editing this checkout or running `deno task build` does not update a running
launcher. By default, launcher builds consume checksum-pinned releases from
`macos/ComposeUI.lock` and `macos/ComposeServer.lock`.

To include local changes when building the launcher, set
`COMPOSE_UI_SOURCE_DIR=/Users/jan/Dev/xe/stacks/darc-worker/svelte` and, for backend
changes, `COMPOSE_SERVER_SOURCE_DIR=/Users/jan/Dev/xe/stacks/compose` on the launcher
`make` invocation. Follow its README for the required guest-worker artifact and
build target. Confirm which bundle/source revision is running before interpreting
live results. Vite alone does not provide the launcher API, VM, or gateway.

## Project Configuration

- **Language**: TypeScript
- **Package Manager**: deno
- **Add-ons**: prettier, eslint, tailwindcss, sveltekit-adapter, devtools-json, mcp

---

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.
