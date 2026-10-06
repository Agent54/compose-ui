# Standalone shell backend handover

Compose Control now opens container shells and a VM shell in separate `/shell/` browser tabs. The frontend and protocol client are implemented in this repository. Real shell access requires the following work in the Compose API, launcher gateway, and VM runtime repositories; no implementation changes were made there.

## Terminal engine decision

| Option                                                                         | Strengths                                                                                                                         | Integration tradeoff                                                                                                                             | Decision                                                                                            |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [xterm.js](https://github.com/xtermjs/xterm.js)                                | Established terminal compatibility, official fit/search/link/Unicode/WebGL addons, screen reader mode, documented browser support | Some newer VT and complex grapheme features lag Ghostty; Unicode addon uses a proposed API                                                       | Selected: xterm.js 6.0.0 with pinned official addons and optional WebGL rendering                   |
| [Ghostty web](https://github.com/coder/ghostty-web)                            | Ghostty emulator compiled to WASM, xterm-style API, project reports stronger complex-script and SGR stack support                 | Its README describes building patched Ghostty source and a future native WASM distribution; integration and accessibility parity need validation | Promising future renderer; keep transport independent                                               |
| [hterm](https://chromium.googlesource.com/apps/libapps/+/HEAD/hterm/README.md) | Portable JavaScript terminal used by Chromium Secure Shell                                                                        | A different integration API and ecosystem would add work to this Svelte client                                                                   | Viable, no clear advantage for this implementation                                                  |
| [ttyd](https://github.com/tsl0922/ttyd)                                        | A packaged terminal server with authentication, origin checks, and browser support                                                | Adds a server process and still needs target selection, start behavior, and integration with existing authorization                              | Consider for a separately managed terminal service; the current gateway can expose the PTY directly |

These are integration judgments, not comparative performance benchmarks. The terminal dependencies load only in the shell tab; no CDN assets or shell tickets are stored in the launch URL. WebKit, narrow viewports, high-density displays, and screen reader mode use the DOM renderer to avoid the GPU glyph sizing errors observed during viewport testing. Other browsers at standard pixel density can use WebGL with DOM fallback on context loss.

## Shared HTTP contract

The API prefix follows the existing `serverUrl` and `apiVersion`; default requests are same-origin under `/v1.24`. Every endpoint must enforce the current application's authorization and allowed browser origins. Creation uses credentialed JSON requests. Cross-origin deployments need an explicit credentialed CORS policy.

`POST /v1.24/shell/sessions` creates one interactive session. Example container request:

```json
{
	"target": {
		"kind": "container",
		"project": "demo",
		"service": "web",
		"containerId": "engine-container-id",
		"path": "/stacks/demo/compose.yml",
		"name": "demo-web-2"
	},
	"shell": "bash",
	"fallbackShell": "sh",
	"startIfStopped": true,
	"resumeIfPaused": true,
	"term": "xterm-256color",
	"cols": 100,
	"rows": 30
}
```

For a VM shell, `target` is exactly `{ "kind": "vm" }`; other fields remain the same. `name` is display metadata. Do not turn any client field into a command string or allow arbitrary command/user/environment arguments. Resolve and authorize the project, service, Compose path, and container on the server.

Return `201` JSON `{ "id": "opaque-session-id", "token": "single-use-base64url-ticket" }` with `Cache-Control: no-store`. The client accepts IDs containing letters, digits, `_`, or `-`, length 1–128; ticket length is 16–512 with the same character set. Tickets must be unpredictable, short-lived, bound to the authenticated session and allowed origin, and excluded from logs. Creation has a 30-second frontend deadline; expire sessions abandoned before their WebSocket attaches. Return JSON `{ "message": "actionable reason" }` on failure. The client treats 404/405/501 as missing interactive-shell support.

`DELETE /v1.24/shell/sessions/{id}` is idempotent and closes only that PTY/exec process. The browser sends it on exit, errors, new-session requests, and tab departure. Network loss can prevent delivery, so the backend must also clean up on disconnect and expire unused tickets. Terminating a container shell must not stop its container or kill the container's main process.

## Shared WebSocket protocol

`GET /v1.24/shell/sessions/{id}/stream` upgrades to a WebSocket on the same API host and path prefix. The client offers subprotocols `compose-shell-v1` and `ticket.<token>`. Validate and consume the ticket, verify the Origin and authorization, then negotiate **only `compose-shell-v1`**. Redact the ticket-bearing header. No credentials belong in a query string. HTTPS API connections become WSS.

| Direction       | Frame                                                     | Meaning                                                                                       |
| --------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Server → client | Text JSON `{ "type": "ready", "shell": "bash" }`          | PTY ready for input; use `sh` when Bash is unavailable                                        |
| Server → client | Binary, maximum 65536 bytes                               | Raw PTY output, including ANSI and UTF-8 sequences; preserve order and byte boundaries        |
| Client → server | Binary, maximum 16384 bytes                               | Raw PTY input; printable text is UTF-8, Ctrl keys and legacy mouse reports retain their bytes |
| Client → server | Text JSON `{ "type": "resize", "cols": 100, "rows": 30 }` | Initial and subsequent PTY window sizes; propagate SIGWINCH/TIOCSWINSZ                        |
| Client → server | Text JSON `{ "type": "ack", "bytes": 4096 }`              | Output bytes consumed by the terminal parser, acknowledged after its write callback           |
| Server → client | Text JSON `{ "type": "exit", "code": 0 }`                 | Shell process ended; send after the final output frames, then close                           |
| Server → client | Text JSON `{ "type": "error", "message": "reason" }`      | Actionable failure, then close                                                                |

The client accepts control frames up to 8192 characters and allows at most 1 MiB of pending output or buffered input. Implement output flow control: send at most 256 KiB of unacknowledged output, pause PTY reads at that watermark, and resume below 64 KiB as ACKs arrive. Count **bytes**, including ANSI escapes and multi-byte Unicode. Clamp and validate sizes and ACKs; never let a malicious ACK create negative outstanding counts. Protocol ping/pong should detect dead clients without introducing new JSON frame types. [xterm flow control guidance](https://xtermjs.org/docs/guides/flowcontrol/)

Connections are not resumed automatically. “New session” closes the old PTY and creates a fresh shell; typed input is never replayed. Output remains in the tab's scrollback across manual session changes.

## Compose repository agent

Repository: `/Users/jan/Dev/xe/stacks/compose`, especially `server/router.go` and existing exec/start/container handlers.

Implement the shared session endpoints for `kind: container`. Inspect the engine's current state when opening the session rather than trusting the dashboard's earlier state. Prefer the exact supplied engine container ID and verify it belongs to the requested Compose project/service. Never substitute a different replica when that ID has disappeared. For a service without an ID, create/start only that Compose service without rebuilding or starting dependencies and resolve its resulting container; reject ambiguous replicas.

For a running container, create a separate interactive exec with a TTY and attached stdin/stdout/stderr. For an exited or created container, start the existing container with its configured main process, wait for it to run, and then exec Bash. Preserve its ID, mounts, configuration, and normal entrypoint. Resume a paused container first. Wait a bounded time for restarting containers and report an immediate main-process exit clearly; do not replace the entrypoint or create a debug copy implicitly.

Use `/bin/bash -i` when available and `/bin/sh -i` otherwise; report the selected shell in `ready`. Never retry with `sh` merely because an already-running Bash session exits with an error. Keep each exec process, resize operation, output stream, and cancellation tied to its session. Existing noninteractive `/exec/{project}` behavior remains separate.

Test running, stopped, created, paused, restarting, absent, and scaled targets; Bash fallback; full-screen TUIs; Ctrl-C; concurrent sessions; resize; fast output; expired/reused tickets; disconnect cleanup; and ensuring shell exit leaves the workload running.

## Launcher repository agent

Repository: `/Users/jan/Dev/xe/stacks/darc-launcher`, especially `workerd/management.js`, `workerd/app-gateway.js`, `workerd/socket-bridge.js`, and `macos/Sources/macos/WorkerdServer.swift`.

Route the session API to Compose for container targets and the VM PTY bridge for VM targets. The management UI is served at `127.0.0.1:8094`; preserve the public browser Origin, WebSocket upgrade, negotiated subprotocol, binary/text frame kinds, and close semantics through every gateway. Do not buffer PTY output as an ordinary HTTP body. Enforce authorization and Origin checks before forwarding privileged VM requests. Support the same API on configured HTTPS UI hosts, including their certificate trust and WSS routes.

Serve `/shell/` as the bundled `shell/index.html` with the existing `_app/` assets, including direct navigation and reload in an external browser. Honor external links with `target="_blank"` and `rel="external noopener noreferrer"` in the desktop webview's navigation/new-window delegate so shell links open in the system browser, outside the embedded dashboard. Preserve the fragment containing launch metadata. Ensure the external browser can authenticate to the local service; a webview-only cookie store does not automatically share authentication with the system browser.

The current `management.js` accepts only file-extension asset paths and maps only `/` to `index.html`; explicitly map `/shell/` to `/shell/index.html` and redirect `/shell` while preserving fragments. Its generic Compose proxy currently strips browser credentials and reconstructs HTTP `Response` objects. Give the shell endpoints an authorized route and preserve the actual WebSocket upgrade response rather than losing its WebSocket object during reconstruction. Do not forward webview credentials blindly to Compose; pass an authenticated identity through a trusted internal mechanism.

For VM targets, ensure the runtime is ready and open a shell inside the Linux VM rather than on macOS. Closing a shell must leave the VM running. Ensure session cleanup survives window close, navigation, gateway failure, and app shutdown.

## smolvm repository agent

Repository: `/Users/jan/Dev/xe/smol/smolvm`, especially `crates/smolvm-agent/src/pty.rs`, `crates/smolvm-agent/src/main.rs`, and `crates/smolvm-protocol/src/lib.rs`.

Reuse the existing interactive `VmExec`, `Resize`, and PTY lifecycle machinery for a Linux VM Bash session. Preserve raw bytes, initial dimensions, subsequent resize, stdin EOF, exit status, signals, and process cleanup across the host/guest bridge. Use a separate interactive connection/session so long-lived shells do not block runtime probes or other exec calls. Apply the output ACK watermarks at the bridge that owns the PTY reads. Return clear startup or guest-shell errors to the session API. This frontend does not require new terminal rendering code in the runtime.

## darc worker gateway agent

Repository area: `/Users/jan/Dev/xe/stacks/darc-worker/workerd` if this worker participates in the deployed shell request path.

Preserve shell WebSocket upgrades and binary frames through the worker's Docker/Compose forwarding layer. Route privileged VM sessions to the launcher bridge. Avoid adding another terminal service if the launcher and Compose endpoints already own sessions. Coordinate routes and authentication with the launcher agent, and test the complete deployed path rather than only a direct backend connection.

## Frontend verification and fixture

Run `deno task check`, `deno task test`, and `deno task build`. The shell protocol tests use injected fetch/socket/terminal adapters to verify session cleanup, UTF-8, binary input, byte ACKs, frame limits, and missing-backend errors.

For browser verification without a runtime, run the local fixture after building:

```sh
deno run --allow-net=127.0.0.1:5180 --allow-read=build scripts/shell-fixture.ts
```

Open `http://127.0.0.1:5180/`, expand the demo project, and use the running `web`, stopped `worker`, or header VM Shell action. The fixture simulates PTY output and input, and supports `pwd`, `unicode`, `stty size`, and `exit`. It never starts a real shell or container. Real PTY, Docker, VM, proxy, TLS, and desktop external-browser behavior require backend integration testing by the respective agents.
