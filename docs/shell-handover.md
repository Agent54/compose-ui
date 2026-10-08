# Standalone shell backend handover

Compose Control opens container shells and a VM shell in separate `/shell/index.html` browser tabs. The frontend, session selector, explicit deletion controls, and browser-local demo backend are implemented here. Real shells require the work below; no implementation changes were made in the other repositories.

This revision replaces the earlier ephemeral PTY plan. **Every real shell must run under dtach with a named Unix socket. Tab close, session switch, reconnect, gateway failure, and idle time only detach; they must never delete a session.** Only an explicit Close session action deletes it. The protocol is now `compose-shell-v2` so a client cannot accidentally attach to the old lifecycle.

## User behavior and persistence

- Normal container/VM Shell clicks atomically attach to the most recently attached session for that exact target and authorized user. Bootstrap the first session only when no records exist. An exited last session remains listed; return an actionable error rather than automatically replacing it.
- Cmd-click in Compose Control sets the one-time `newSession: true` launch flag. The terminal consumes and removes it before connecting so reloading that tab reattaches. Selecting New session in the terminal header also creates a new named dtach session. Creating a session detaches the browser from the old session and leaves its processes running.
- The header dropdown lists all sessions for the current target, showing number/name, current foreground command, cwd, and running/exited state. Selecting an entry attaches by ID and updates the target's last-attached pointer. It never silently creates a replacement for a missing ID.
- Close session in the main header, or the close button beside a dropdown entry, terminates that session's owned process tree, disconnects its attachments, and deletes its socket and registry entry. Closing the current session leaves the terminal idle until the user selects another or New session. Closing a background session leaves the current one attached.
- Sessions persist across browser windows, reloads, gateway restarts, and disconnects while their container/VM is running. dtach cannot keep processes alive across container termination or VM shutdown. Retain exited metadata through those events until explicitly deleted, and reconcile live sockets with the registry on recovery. Never claim reboot survival or restart lost commands automatically.
- The browser uses a clearly marked demo backend when the live list API or initial stream is unavailable. Demo sessions and their simulated output are saved in localStorage, scoped to the API and exact target. No commands run on the container/VM. Authentication failures remain visible. Retry live backend explicitly switches back; never mix demo and real sessions or silently replay input.

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

`GET /v1.24/shell/sessions?target=<URL-encoded JSON target>` lists the authenticated user's sessions for one exact target. Return `200` JSON `{ "sessions": [...] }`, including exited records until explicit deletion. The target has the same shape as the POST example. Include `Cache-Control: no-store` on every response. Refresh command/cwd metadata on GET; the frontend polls every five seconds while visible and refreshes on dropdown open.

`POST /v1.24/shell/sessions` opens one browser attachment, with mode `attach-last`, `create`, or `attach`. Example container request:

```json
{
	"engine": "dtach",
	"target": {
		"kind": "container",
		"project": "demo",
		"service": "web",
		"containerId": "engine-container-id",
		"path": "/stacks/demo/compose.yml",
		"name": "demo-web-2"
	},
	"mode": "attach-last",
	"shell": "bash",
	"fallbackShell": "sh",
	"startIfStopped": true,
	"resumeIfPaused": true,
	"term": "xterm-256color",
	"cols": 100,
	"rows": 30
}
```

For mode `attach`, also provide `sessionId`. Mode `create` always allocates a new session; `attach-last` resolves and attaches atomically under a per-user/per-target lock, creating only the initial session when the registry is empty. Update the last-attached pointer only after successful attachment. Mode `attach` must return 404 for a deleted session and 409 for an exited session. Never recreate it. For a VM shell, `target` is exactly `{ "kind": "vm" }`. Container `name` is display metadata. Do not turn client fields into command strings or accept arbitrary socket paths, command/user/environment arguments. Resolve and authorize the project, service, Compose path, and container on the server.

Return `200` for attachment or `201` for creation, with the same JSON shape:

```json
{
	"session": {
		"engine": "dtach",
		"id": "opaque-session-id",
		"number": 3,
		"name": "Session 3",
		"socketName": "s3-opaque-session-id.sock",
		"command": "bash",
		"cwd": "/workspace",
		"shell": "bash",
		"state": "running"
	},
	"token": "single-use-base64url-ticket"
}
```

List entries use exactly the `session` shape. Engine must be `dtach`; the frontend rejects unmanaged sessions. Number is a positive safe integer allocated monotonically within the target. Names may be server-provided; this UI does not yet rename them. IDs contain letters, digits, `_`, or `-`, length 1–128; ticket length is 16–512 with the same character set. Metadata strings are bounded to 4096 characters and contain no control characters. Exited records have state `exited`, an empty command if unknown, and their last known cwd.

Tickets must be unpredictable, short-lived, single-use, bound to the authenticated user, target, session, attachment and allowed origin, and excluded from logs. The client gives session opening 30 seconds, list/delete four seconds, and the initial stream four seconds. **Expire unused attachment tickets, never the persistent dtach session.** A canceled or late HTTP response may leave a newly created session; retain it so the next list/normal open can find it. Return JSON `{ "message": "actionable reason" }` on failures.

`DELETE /v1.24/shell/sessions/{id}` is the sole explicit termination operation, authorized by registry ownership. It is idempotent and returns 204. Terminate the dtach master and its owned process group/cgroup, close all attachments, unlink only the verified owned socket and metadata, then remove the registry entry. Never stop the container, VM, or unrelated workload. Do not implement delete-on-disconnect, delete-on-exit, idle expiration, or deletion when starting a new session.

## Shared WebSocket protocol

`GET /v1.24/shell/sessions/{id}/stream` upgrades to a WebSocket on the same API host and path prefix. The client offers `compose-shell-v2` and `ticket.<token>`. Validate and consume the ticket, verify Origin and authorization, then negotiate **only `compose-shell-v2`**. Redact the ticket-bearing header. No credentials belong in a query string. HTTPS API connections become WSS. Each WebSocket owns a dtach attachment, not the session master.

| Direction       | Frame                                                     | Meaning                                                                                       |
| --------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Server → client | Text JSON `{ "type": "ready", "shell": "bash" }`          | PTY ready for input; use `sh` when Bash is unavailable                                        |
| Server → client | Binary, maximum 65536 bytes                               | Raw PTY output, including ANSI and UTF-8 sequences; preserve order and byte boundaries        |
| Client → server | Binary, maximum 16384 bytes                               | Raw PTY input; printable text is UTF-8, Ctrl keys and legacy mouse reports retain their bytes |
| Client → server | Text JSON `{ "type": "resize", "cols": 100, "rows": 30 }` | Initial and subsequent PTY window sizes; propagate SIGWINCH/TIOCSWINSZ                        |
| Client → server | Text JSON `{ "type": "ack", "bytes": 4096 }`              | Output bytes consumed by the terminal parser, acknowledged after its write callback           |
| Server → client | Text JSON `{ "type": "exit", "code": 0 }`                 | Shell ended; retain its exited registry entry; send after final output, then close attachment |
| Server → client | Text JSON `{ "type": "error", "message": "reason" }`      | Actionable failure, then close                                                                |

The client accepts control frames up to 8192 characters and allows at most 1 MiB of pending output or buffered input. Implement output flow control: send at most 256 KiB of unacknowledged output, pause PTY reads at that watermark, and resume below 64 KiB as ACKs arrive. Count **bytes**, including ANSI escapes and multi-byte Unicode. Clamp and validate sizes and ACKs; never let a malicious ACK create negative outstanding counts. Protocol ping/pong should detect dead clients without introducing new JSON frame types. [xterm flow control guidance](https://xtermjs.org/docs/guides/flowcontrol/)

Disconnected browsers reconnect by session ID without replaying input. New session only detaches the old attachment. The terminal resets its display when changing attachments so output from different sessions is not mixed. dtach does not retain a terminal screen or scrollback; arrange resize/redraw on reattachment, and document that real output produced while detached is not replayed. Do not inject typed commands or Ctrl-L as a substitute for replay. [dtach behavior and socket-based attachment](https://dtach.sourceforge.net/)

## Native command editor and the next interface revision

The frontend now has a native textarea below xterm. An escaped, lossless token layer highlights unfinished shell text without replacing browser caret, selection, paste, undo, or IME behavior. Enter sends the draft to the current attachment, Shift+Enter inserts a line, and ordinary Tab retains browser focus navigation. Commands are sent as UTF-8 PTY input, honoring the terminal's bracketed paste mode and ending with Enter. This uses the existing v2 stream; it never allocates another exec process or session. Use it at a shell prompt; foreground interactive programs, password prompts, and partially edited readline buffers still receive PTY input at their current cursor. Use xterm for those interactions until prompt integration is implemented.

The editor has its own IndexedDB history, separate from Bash history and xterm scrollback. Each accepted submission stores the complete text, timestamp, session ID and last known cwd. This records input submitted to the socket, not proof that a command completed successfully. Duplicate and multiline submissions are retained. History is shared across sessions for an exact target/API/browser origin and isolated between live and demo backends. Closing a dtach session does not erase editor history. There is no count limit, truncation or automatic pruning; browser quota, site-data clearing, and browser eviction still apply. Failed writes are shown in the editor. Read indexed pages of 40 entries and individual older/newer neighbors so history size does not determine startup memory. Recall only fills the draft; it never executes it. Unsent drafts survive session changes and live/demo retries within the tab.

Keep the editor, highlighting, history storage and PTY submission separate (`ShellCommandInput.svelte`, `shell/command.ts`, `shell/history.ts`, and `ShellTerminal.sendCommand`). The next Warp-style step is prompt-aware execution, tab completion and a folder picker. Coordinate this with the same named dtach owner; do not add ephemeral completion shells or change attach-last/create/delete behavior.

- **Compose and smolvm agents:** Provide opt-in Bash/sh prompt integration that reports prompt-ready/busy state, an input revision, authoritative cwd, and command start/finish information for the owned session. Polling foreground command/cwd alone cannot identify a safe shell prompt. Preserve integration across detach and reattach; unsupported shells/TUIs continue to use raw xterm. Never treat arbitrary OSC text from program output as a privileged request.
- **Compose / launcher / guest session owners:** Design authenticated completion and directory-list operations scoped to the same authorized target and session. Requests need a request ID, draft, UTF-16 caret/replacement offsets, input revision and cwd. Responses need bounded labeled items, insertion text, replacement range and file/directory kind. Directory browsing must operate in the target namespace, follow the target user's permissions, and accept paths as data. Never construct an `eval`, command string, or fresh `bash -c` from the draft. Requesting or highlighting a completion must not run the command or create/delete a dtach session.
- **Launcher and worker gateway agents:** Preserve authorization and cancellation for these operations. Coordinate an explicit capability/version extension before sending new stream controls: this v2 client rejects unknown control frames. Reuse the session registry and existing transport routing.
- **Future frontend agent:** Add a cancellable provider behind the native editor, discard stale results after text/caret/cwd/session changes, apply insertions with native selection APIs, and preserve IME, undo and browser shortcuts. Tab may accept a visible suggestion only when completion is available; otherwise keep ordinary focus navigation. Selecting a folder edits the draft and requires explicit Enter/Run to send it. Add command blocks only after reliable prompt/exit events exist. If authentication adds account switching, include the authorized identity in local history scope.

No completion, prompt-integration, or directory APIs have been implemented in other repositories here.

## dtach session ownership and metadata

Allocate one immutable socket name per session, such as `s3-<random-id>.sock`, in a short backend-controlled directory inside the target (`/run/compose-shell/<scope-hash>/`). Keep Unix socket paths within the platform limit. Use private directory ownership and mode 0700, a restrictive umask, socket access controls, and a registry bound to the authenticated user and exact VM/container identity. Never accept a browser-supplied path, follow an unverified symlink, reuse another replica's socket, or remove files outside that registry.

Create with dtach's separate new-session mode (`-n`) and attach existing sockets with `-a`, disabling dtach's detach/suspend key interception (`-E -z`) so raw Ctrl keys reach the shell. Use a suitable redraw method such as `-r winch`, propagate dimensions, and test shells and full-screen TUIs. Avoid `-A` on an explicit selected ID because it can silently recreate a vanished session. Package dtach in the VM runtime and provide an explicit supported container strategy; if dtach is missing, report that requirement. **Never fall back to an unmanaged raw PTY.** Bash may fall back to sh, but both must run under dtach. [dtach command modes](https://github.com/crigler/dtach)

dtach does not provide a session-list API or command/cwd metadata. The owner must maintain a registry containing session number/name, target and user, socket, master/child identifiers, shell, state, timestamps and last-attachment order. Obtain the current foreground process group from the owning PTY and read its command/cwd in the correct Linux namespace, with a bounded safe fallback to the shell's last known metadata. Read metadata without executing command strings in the target. Reconcile process exits and stale sockets, retaining exited records until DELETE. Do not automatically restart an exited command to preserve the appearance of a persistent session.

Multiple browsers may attach to one session. Coordinate resize ownership (the most recent active attachment may control dimensions), and ensure disconnect kills only that browser's attach process. Explicit deletion must disconnect all viewers. A gateway shutdown must leave the guest/container dtach master alive.

## Compose repository agent

Repository: `/Users/jan/Dev/xe/stacks/compose`, especially `server/router.go` and existing exec/start/container handlers.

Implement the shared session endpoints for `kind: container`. Inspect the engine's current state when opening the session rather than trusting the dashboard's earlier state. Prefer the exact supplied engine container ID and verify it belongs to the requested Compose project/service. Never substitute a different replica when that ID has disappeared. For a service without an ID, create/start only that Compose service without rebuilding or starting dependencies and resolve its resulting container; reject ambiguous replicas.

For a running container, resolve/create its named dtach session and exec only a dtach attachment with a TTY and attached stdin/stdout/stderr. Keep the master/shell independent of that exec attachment. For an exited or created container, start the existing container with its configured main process, wait for it to run, reconcile the registry, and attach. Preserve its ID, mounts, configuration, and normal entrypoint. Resume paused containers first. Wait a bounded time for restarting containers and report immediate main-process exit clearly; never replace the entrypoint or create a debug copy implicitly. Old dtach processes cannot survive a stopped container; retain their exited records and require explicit New session.

Run `/bin/bash -i` under dtach when available and `/bin/sh -i` under dtach otherwise; report the selected shell in `ready`. Never retry with sh because an existing Bash session exits with an error. Implement the target-scoped registry, atomic attach-last/create/select, fresh foreground command/cwd listing, and explicit deletion. Keep attachment exec cancellation separate from master lifecycle. Existing noninteractive `/exec/{project}` behavior remains separate.

Test all container states and replicas; required dtach provisioning; Bash/sh fallback; simultaneous normal opens creating only one initial session; Cmd/New creating additional sessions; latest-session selection; reload/switch/disconnect persistence; command/cwd changes; metadata reconciliation after container stop; explicit deletion of foreground/background sessions; TUIs, Ctrl-C/Ctrl-Z, resize, flow control and tickets; and ensuring deletion/exit leaves the workload running.

## Launcher repository agent

Repository: `/Users/jan/Dev/xe/stacks/darc-launcher`, especially `workerd/management.js`, `workerd/app-gateway.js`, `workerd/socket-bridge.js`, and `macos/Sources/macos/WorkerdServer.swift`.

Route the session API to Compose for container targets and the VM PTY bridge for VM targets. The management UI is served at `127.0.0.1:8094`; preserve the public browser Origin, WebSocket upgrade, negotiated subprotocol, binary/text frame kinds, and close semantics through every gateway. Do not buffer PTY output as an ordinary HTTP body. Enforce authorization and Origin checks before forwarding privileged VM requests. Support the same API on configured HTTPS UI hosts, including their certificate trust and WSS routes.

Serve the explicit `/shell/index.html` file and existing `_app/` assets for direct navigation/reload in an external browser. The frontend now uses that file URL to work with the current extension-only static gateway; its universal Svelte reroute maps the file alias to the shell route for hydration. Also map `/shell/` to that file for older links and redirect `/shell` without losing its fragment. Honor external links and `window.open` with opener isolation in the desktop webview's navigation/new-window delegate so both normal and Cmd-click shell links open in the system browser. Preserve launch metadata and the one-time new-session flag. Ensure external-browser authentication; a webview-only cookie store does not share it automatically.

The reported `https://compose-ui.localhost/shell/` Not found originates in the current extension-only `management.js` asset routing. The frontend file link avoids it once the new bundle is shipped; implement the old-link alias in this repository. The generic Compose proxy also strips browser credentials and reconstructs HTTP Response objects. Give all list/open/delete/stream endpoints an authorized route and preserve the actual WebSocket upgrade response. Pass authenticated identity through a trusted internal mechanism rather than blindly forwarding browser credentials.

For VM targets, ensure the runtime is ready and route to a named dtach session inside Linux. Implement or coordinate the VM registry and session endpoints. Window close/navigation, gateway failure, and launcher connection shutdown only detach. Explicit deletion leaves the VM running. Do not terminate dtach masters during attachment cleanup.

## smolvm repository agent

Repository: `/Users/jan/Dev/xe/smol/smolvm`, especially `crates/smolvm-agent/src/pty.rs`, `crates/smolvm-agent/src/main.rs`, and `crates/smolvm-protocol/src/lib.rs`.

Package dtach in the guest and adapt the existing VmExec/Resize/PTY bridge to attach to named dtach sockets. The guest owns long-lived masters and persistent metadata independently of each host connection. Provide list/open/select/delete operations and foreground command/cwd metadata to the launcher; coordinate which repository owns the authoritative registry. Preserve bytes, dimensions, signals and attachment exit status. Use separate interactive connections so shells do not block probes. A disconnected VmExec closes only its attach process; explicit DELETE terminates the session master and owned jobs. Apply byte-ACK flow control at the PTY reader. Reconcile exited records after VM restart; never silently restart lost commands. No new rendering code is needed here.

## darc worker gateway agent

Repository area: `/Users/jan/Dev/xe/stacks/darc-worker/workerd` if this worker participates in the deployed shell request path.

Forward the v2 list/open/delete/stream API and preserve upgrades and frame kinds. Route privileged VM sessions to the launcher. Disconnect/cancellation releases only the attachment; it must not trigger DELETE. Avoid another session owner if Compose and the launcher/guest already own registries. Coordinate authentication and test the complete deployed path.

## Frontend verification and fixture

Run `deno task check`, `deno task test`, and `deno task build`. The shell protocol tests use injected fetch/socket/terminal adapters to verify session cleanup, UTF-8, binary input, byte ACKs, frame limits, and missing-backend errors.

For browser verification without a runtime, run the local fixture after building:

```sh
deno run --allow-net=127.0.0.1:5180 --allow-read=build scripts/shell-fixture.ts
```

Open `http://127.0.0.1:5180/`, expand the demo project, and use a container or VM Shell action. The fixture deliberately exposes no shell backend and resolves only explicit file paths (plus the root dashboard), matching the reported host. The browser fallback supports pwd, cd, ls, echo, unicode, stty size, sleep, clear and exit without executing commands. Verify normal/⌘ opening, New session, switching, reload persistence, command/cwd display, hover/focus deletion, deletion in another tab, and Retry live backend. Real dtach, Docker, VM, TLS and desktop external-browser behavior need backend integration tests by the respective agents.

For the command editor, verify native selection/replacement/undo and caret movement, Unicode, Enter/Shift+Enter, multiline history, ↑/↓ with draft restoration, and History recall without execution. Submit more than 40 entries and load older pages, then reload to check persistence. Check shared history across sessions, separate VM/container and demo/live scopes, and draft retention during backend retries. Verify highlighting stays aligned during horizontal scrolling on desktop and a narrow viewport. The current browser verification covers 49 retained submissions, reload, session sharing, VM isolation, and 1440px/390px layouts.
