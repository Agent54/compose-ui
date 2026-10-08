import {
	SHELL_PROTOCOL,
	ShellBackendUnavailable,
	type ShellBackend,
	type ShellSelection,
	type ShellSession,
	type ShellSocket
} from './session';

export type ShellStatus = {
	phase: 'connecting' | 'connected' | 'closed' | 'error';
	message: string;
	shell?: 'bash' | 'sh';
	session?: ShellSession;
};
export interface ShellSink {
	cols: number;
	rows: number;
	write(data: Uint8Array, callback: () => void): void;
}
const encoder = new TextEncoder();
const MAX_PENDING_BYTES = 1024 * 1024;

/** One attachment. Disposal only detaches; DELETE is reserved for explicit user actions. */
export class ShellTransport {
	private readonly controller = new AbortController();
	private socket?: ShellSocket;
	private session?: ShellSession;
	private disposed = false;
	private ready = false;
	private finished = false;
	private pendingBytes = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private resolve?: () => void;
	private reject?: (error: Error) => void;
	constructor(
		private backend: ShellBackend,
		private terminal: ShellSink,
		private onStatus: (status: ShellStatus) => void
	) {}
	async connect(selection: ShellSelection = { mode: 'attach-last' }) {
		this.onStatus({
			phase: 'connecting',
			message: selection.mode === 'create' ? 'Creating session…' : 'Attaching to session…'
		});
		try {
			const attachment = await this.backend.attach(
				selection,
				this.terminal.cols,
				this.terminal.rows,
				this.controller.signal
			);
			if (this.disposed) return;
			this.session = attachment.session;
			const socket = this.backend.openSocket(attachment);
			this.socket = socket;
			socket.binaryType = 'arraybuffer';
			const connected = new Promise<void>((resolve, reject) => {
				this.resolve = resolve;
				this.reject = reject;
			});
			this.timer = setTimeout(
				() => this.fail(new ShellBackendUnavailable('The live shell stream did not respond.')),
				4000
			);
			socket.onopen = () => this.resize(this.terminal.cols, this.terminal.rows);
			socket.onmessage = (event) => this.receive(event.data);
			socket.onerror = () =>
				this.fail(
					this.ready
						? new Error('The shell connection failed. Reconnect to this session.')
						: new ShellBackendUnavailable('The live shell stream could not be reached.')
				);
			socket.onclose = () => {
				if (!this.finished && !this.disposed)
					this.fail(
						this.ready
							? new Error('Detached. Your session is still available; reconnect to continue.')
							: new ShellBackendUnavailable('The live shell stream disconnected before attaching.')
					);
			};
			await connected;
		} catch (error) {
			if (!this.disposed) {
				this.fail(error instanceof Error ? error : new Error('Could not attach to the shell.'));
				throw error;
			}
		}
	}
	private receive(data: unknown) {
		if (this.finished || this.disposed) return;
		if (data instanceof ArrayBuffer) {
			const bytes = new Uint8Array(data);
			if (bytes.length > 65536 || this.pendingBytes + bytes.length > MAX_PENDING_BYTES) {
				this.fail(new Error('The shell sent too much output. Reconnect to this session.'));
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
					shell: message.shell,
					session: this.session
				});
				this.resolve?.();
				this.resolve = undefined;
				this.reject = undefined;
			} else if (message.type === 'exit' && Number.isInteger(message.code))
				this.finish({
					phase: 'closed',
					message: `Shell exited with code ${message.code}. Select New session to start another.`,
					session: this.session
				});
			else if (message.type === 'error' && typeof message.message === 'string')
				this.fail(new Error(message.message.slice(0, 500)));
			else throw new Error('Unknown control frame');
		} catch {
			this.fail(
				new Error(
					`The shell server sent an unsupported message. It must support ${SHELL_PROTOCOL}.`
				)
			);
		}
	}
	input(data: string, binary = false): boolean {
		if (!this.ready || this.finished || this.disposed || this.socket?.readyState !== 1)
			return false;
		const bytes = binary
			? Uint8Array.from(data, (char) => char.charCodeAt(0))
			: encoder.encode(data);
		if (this.socket.bufferedAmount + bytes.length > MAX_PENDING_BYTES) {
			this.fail(
				new Error(
					'The shell connection cannot keep up with input. Reconnect and try a smaller paste.'
				)
			);
			return false;
		}
		for (let offset = 0; offset < bytes.length; offset += 16384)
			this.socket.send(bytes.subarray(offset, offset + 16384));
		return true;
	}
	resize(cols: number, rows: number) {
		this.sendControl({ type: 'resize', cols, rows });
	}
	private sendControl(message: object) {
		if (!this.finished && !this.disposed && this.socket?.readyState === 1)
			this.socket.send(JSON.stringify(message));
	}
	private fail(error: Error) {
		this.finish({ phase: 'error', message: error.message, session: this.session }, error);
	}
	private finish(status: ShellStatus, error = new Error(status.message)) {
		if (this.finished || this.disposed) return;
		this.finished = true;
		this.ready = false;
		clearTimeout(this.timer);
		this.controller.abort();
		this.socket?.close();
		this.reject?.(error);
		this.resolve = undefined;
		this.reject = undefined;
		this.onStatus(status);
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.ready = false;
		clearTimeout(this.timer);
		this.controller.abort();
		this.socket?.close();
		this.resolve?.();
		this.resolve = undefined;
		this.reject = undefined;
	}
}
