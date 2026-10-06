import { shellApiBase, type ShellLaunch } from './launch';

export type ShellStatus = {
	phase: 'connecting' | 'connected' | 'closed' | 'error';
	message: string;
	shell?: 'bash' | 'sh';
};
export interface ShellSink {
	cols: number;
	rows: number;
	write(data: Uint8Array, callback: () => void): void;
}

type ShellSocket = Pick<
	WebSocket,
	| 'binaryType'
	| 'readyState'
	| 'bufferedAmount'
	| 'onopen'
	| 'onmessage'
	| 'onerror'
	| 'onclose'
	| 'send'
	| 'close'
>;
type Dependencies = {
	fetch: typeof fetch;
	socket: (url: string, protocols: string[]) => ShellSocket;
};

const encoder = new TextEncoder();
const MAX_PENDING_BYTES = 1024 * 1024;

/** One PTY per connection. Reconnect explicitly creates a fresh session; never replay input. */
export class ShellTransport {
	private readonly apiBase: string;
	private readonly controller = new AbortController();
	private sessionId = '';
	private socket?: ShellSocket;
	private disposed = false;
	private ready = false;
	private finished = false;
	private pendingBytes = 0;
	private timer?: ReturnType<typeof setTimeout>;

	constructor(
		private launch: ShellLaunch,
		origin: string,
		private terminal: ShellSink,
		private onStatus: (status: ShellStatus) => void,
		private dependencies: Dependencies = {
			fetch: globalThis.fetch.bind(globalThis),
			socket: (url, protocols) => new WebSocket(url, protocols)
		}
	) {
		this.apiBase = shellApiBase(launch, origin);
	}

	async connect() {
		this.onStatus({ phase: 'connecting', message: 'Starting shell…' });
		this.timer = setTimeout(() => {
			this.fail('Starting the shell timed out. Check the VM and try again.');
		}, 30000);
		try {
			const response = await this.dependencies.fetch(this.apiBase, {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				signal: this.controller.signal,
				body: JSON.stringify({
					target: this.launch.target,
					shell: 'bash',
					fallbackShell: 'sh',
					startIfStopped: true,
					resumeIfPaused: true,
					term: 'xterm-256color',
					cols: this.terminal.cols,
					rows: this.terminal.rows
				})
			});
			if (!response.ok) {
				if ([404, 405, 501].includes(response.status)) {
					throw new Error(
						'This server does not support interactive shells yet. Update the shell backend, then reconnect.'
					);
				}
				let detail = '';
				try {
					const body = await response.json();
					if (typeof body.message === 'string') detail = body.message.slice(0, 500);
				} catch {
					/* HTTP status is enough when there is no JSON error body. */
				}
				throw new Error(detail || `Starting shell failed (HTTP ${response.status}).`);
			}
			const session = await response.json();
			if (typeof session.id !== 'string' || !/^[\w-]{1,128}$/.test(session.id)) {
				throw new Error('The shell server returned an invalid session ID.');
			}
			this.sessionId = session.id;
			if (this.disposed || this.finished) {
				this.releaseSession();
				return;
			}
			if (typeof session.token !== 'string' || !/^[\w-]{16,512}$/.test(session.token)) {
				throw new Error('The shell server returned an invalid connection ticket.');
			}
			const url = new URL(`${this.apiBase}/${this.sessionId}/stream`);
			url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
			const socket = this.dependencies.socket(url.href, [
				'compose-shell-v1',
				`ticket.${session.token}`
			]);
			this.socket = socket;
			socket.binaryType = 'arraybuffer';
			socket.onopen = () => this.resize(this.terminal.cols, this.terminal.rows);
			socket.onmessage = (event) => this.receive(event.data);
			socket.onerror = () =>
				this.fail('The shell connection failed. Check the VM connection and reconnect.');
			socket.onclose = () => {
				if (this.finished || this.disposed) return;
				this.fail('The shell disconnected. Reconnect to open a new shell.');
			};
		} catch (error) {
			if (!this.disposed && !this.finished) {
				this.fail(error instanceof Error ? error.message : 'Could not start the shell.');
			}
		}
	}

	private receive(data: unknown) {
		if (this.finished || this.disposed) return;
		if (data instanceof ArrayBuffer) {
			const bytes = new Uint8Array(data);
			if (bytes.length > 65536 || this.pendingBytes + bytes.length > MAX_PENDING_BYTES) {
				this.fail('The shell sent too much output. Reconnect to open a new shell.');
				return;
			}
			this.pendingBytes += bytes.length;
			this.terminal.write(bytes, () => {
				this.pendingBytes -= bytes.length;
				this.sendControl({ type: 'ack', bytes: bytes.length });
			});
			return;
		}
		try {
			if (typeof data !== 'string' || data.length > 8192) throw new Error('Invalid control frame');
			const message = JSON.parse(data);
			if (message.type === 'ready' && ['bash', 'sh'].includes(message.shell)) {
				this.ready = true;
				clearTimeout(this.timer);
				this.onStatus({
					phase: 'connected',
					message: message.shell === 'sh' ? 'Connected · Bash unavailable; using sh' : 'Connected',
					shell: message.shell
				});
			} else if (message.type === 'exit' && Number.isInteger(message.code)) {
				this.finish({ phase: 'closed', message: `Shell exited with code ${message.code}.` });
			} else if (message.type === 'error' && typeof message.message === 'string') {
				this.fail(message.message.slice(0, 500));
			} else {
				throw new Error('Unknown control frame');
			}
		} catch {
			this.fail(
				'The shell server sent an unsupported message. Check that the server supports compose-shell-v1.'
			);
		}
	}

	input(data: string, binary = false) {
		if (!this.ready || this.finished || this.disposed || this.socket?.readyState !== 1) return;
		const bytes = binary
			? Uint8Array.from(data, (char) => char.charCodeAt(0))
			: encoder.encode(data);
		if (this.socket.bufferedAmount + bytes.length > MAX_PENDING_BYTES) {
			this.fail(
				'The shell connection cannot keep up with input. Reconnect and try a smaller paste.'
			);
			return;
		}
		for (let offset = 0; offset < bytes.length; offset += 16384) {
			this.socket.send(bytes.subarray(offset, offset + 16384));
		}
	}

	resize(cols: number, rows: number) {
		this.sendControl({ type: 'resize', cols, rows });
	}

	private sendControl(message: object) {
		if (!this.finished && !this.disposed && this.socket?.readyState === 1) {
			this.socket.send(JSON.stringify(message));
		}
	}

	private fail(message: string) {
		this.finish({ phase: 'error', message });
	}

	private finish(status: ShellStatus) {
		if (this.finished || this.disposed) return;
		this.finished = true;
		this.ready = false;
		clearTimeout(this.timer);
		this.controller.abort();
		this.socket?.close();
		this.releaseSession();
		this.onStatus(status);
	}

	private releaseSession() {
		if (!this.sessionId) return;
		const id = this.sessionId;
		this.sessionId = '';
		void this.dependencies
			.fetch(`${this.apiBase}/${id}`, {
				method: 'DELETE',
				credentials: 'include',
				keepalive: true
			})
			.catch(() => {
				/* The backend also expires disconnected and unused PTYs. */
			});
	}

	dispose() {
		this.disposed = true;
		this.ready = false;
		clearTimeout(this.timer);
		this.controller.abort();
		this.socket?.close();
		this.releaseSession();
	}
}
