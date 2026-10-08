import type { ShellLaunch } from './launch';
import {
	parseSession,
	type ShellAttachment,
	type ShellBackend,
	type ShellSelection,
	type ShellSession,
	type ShellSocket
} from './session';

type DemoSession = ShellSession & { history: string; input: string };
type Registry = { nextNumber: number; lastId?: string; sessions: DemoSession[] };
export type DemoStorage = Pick<Storage, 'getItem' | 'setItem'>;
const encoder = new TextEncoder();
function historyTail(text: string) {
	const tail = text.slice(-32000);
	// Avoid cutting a UTF-16 surrogate pair at the retained scrollback boundary.
	return tail.charCodeAt(0) >= 0xdc00 && tail.charCodeAt(0) <= 0xdfff ? tail.slice(1) : tail;
}

/** Browser-local simulation of the backend contract. Never executes commands. */
export class DemoShellBackend implements ShellBackend {
	readonly kind = 'demo';
	private readonly key: string;
	private readonly tickets = new Map<string, string>();
	private readonly sockets = new Set<DemoSocket>();
	constructor(
		launch: ShellLaunch,
		private storage: DemoStorage,
		private id = () => crypto.randomUUID()
	) {
		const target = launch.target;
		this.key = `compose-shell-demo-v2:${JSON.stringify([
			launch.serverUrl,
			launch.apiVersion,
			target.kind === 'vm'
				? 'vm'
				: [target.project, target.service, target.containerId ?? '', target.path]
		])}`;
	}
	private read(): Registry {
		try {
			const value = JSON.parse(this.storage.getItem(this.key) || 'null');
			if (
				value &&
				Number.isSafeInteger(value.nextNumber) &&
				value.nextNumber >= 1 &&
				Array.isArray(value.sessions)
			) {
				return {
					nextNumber: value.nextNumber,
					lastId: value.lastId,
					sessions: value.sessions.map((item: DemoSession) => ({
						...parseSession({ ...item, engine: item.engine ?? 'dtach' }),
						history: typeof item.history === 'string' ? historyTail(item.history) : '',
						input: typeof item.input === 'string' ? item.input.slice(0, 4096) : ''
					}))
				};
			}
		} catch {
			/* A damaged demo record can be replaced without affecting real sessions. */
		}
		return { nextNumber: 1, sessions: [] };
	}
	private save(registry: Registry) {
		this.storage.setItem(this.key, JSON.stringify(registry));
	}
	async list() {
		return this.read().sessions.map(parseSession);
	}
	async attach(selection: ShellSelection, _cols: number, _rows: number, signal: AbortSignal) {
		signal.throwIfAborted();
		const registry = this.read();
		let session =
			selection.mode === 'attach'
				? registry.sessions.find((item) => item.id === selection.sessionId)
				: selection.mode === 'attach-last'
					? (registry.sessions.find((item) => item.id === registry.lastId) ??
						registry.sessions.at(-1))
					: undefined;
		if (selection.mode === 'attach' && !session)
			throw new Error('That demo session was closed. Select another session.');
		if (!session) {
			const number = registry.nextNumber++;
			const id = this.id();
			session = {
				engine: 'dtach',
				id,
				number,
				name: `Session ${number}`,
				socketName: `session-${number}-${id}.sock`,
				command: 'bash',
				cwd: '/home/demo',
				shell: 'bash',
				state: 'running',
				input: '',
				history:
					'\x1b[1mDemo shell\x1b[0m\r\nNo commands run on your container or VM.\r\nTry help, pwd, cd /var/log, unicode, or sleep 600.\r\n\r\n'
			};
			registry.sessions.push(session);
			session.history += this.prompt(session);
		}
		if (session.state === 'exited')
			throw new Error('This session has exited. Select New session or close this session.');
		registry.lastId = session.id;
		this.save(registry);
		const token = this.id().replaceAll('-', '');
		this.tickets.set(token, session.id);
		return { session: parseSession(session), token };
	}
	openSocket(attachment: ShellAttachment): ShellSocket {
		if (this.tickets.get(attachment.token) !== attachment.session.id)
			throw new Error('Invalid demo ticket.');
		this.tickets.delete(attachment.token);
		const socket = new DemoSocket(this, attachment.session.id);
		this.sockets.add(socket);
		queueMicrotask(() => socket.open());
		return socket;
	}
	async delete(id: string) {
		const registry = this.read();
		registry.sessions = registry.sessions.filter((item) => item.id !== id);
		if (registry.lastId === id) registry.lastId = registry.sessions.at(-1)?.id;
		this.save(registry);
		for (const socket of this.sockets) if (socket.sessionId === id) socket.close();
	}
	detach(socket: DemoSocket) {
		this.sockets.delete(socket);
	}
	get(id: string) {
		return this.read().sessions.find((item) => item.id === id);
	}
	private prompt(session: DemoSession) {
		return `\x1b[32mdemo\x1b[0m:${session.cwd}$ `;
	}
	redraw(socket: DemoSocket) {
		const session = this.get(socket.sessionId);
		if (!session || session.state !== 'running') {
			socket.close();
			return;
		}
		socket.control({ type: 'ready', shell: session.shell });
		socket.output(session.history);
	}
	input(socket: DemoSocket, text: string) {
		const registry = this.read();
		const session = registry.sessions.find((item) => item.id === socket.sessionId);
		if (!session || session.state !== 'running') {
			socket.close();
			return;
		}
		let output = '';
		for (const char of text) {
			if (char === '\x03') {
				session.input = '';
				session.command = 'bash';
				output += `^C\r\n${this.prompt(session)}`;
			} else if (session.command.startsWith('sleep ')) continue;
			else if (char === '\r' || char === '\n') {
				const command = session.input.trim();
				session.input = '';
				output += '\r\n';
				if (command === 'exit') {
					session.state = 'exited';
					session.command = '';
					break;
				}
				if (command === 'pwd') output += `${session.cwd}\r\n`;
				else if (command.startsWith('cd ')) {
					const path = command.slice(3).trim();
					const resolved: string[] = [];
					for (const part of (path.startsWith('/') ? path : `${session.cwd}/${path}`).split('/')) {
						if (part === '..') resolved.pop();
						else if (part && part !== '.') resolved.push(part);
					}
					session.cwd = `/${resolved.join('/')}`;
				} else if (command === 'cd') session.cwd = '/home/demo';
				else if (command === 'ls') output += 'demo.txt  projects/  logs/\r\n';
				else if (command === 'help')
					output +=
						'Demo commands: pwd, cd PATH, ls, echo TEXT, unicode, stty size, sleep N, clear, exit\r\nSessions persist in this browser. Close session explicitly deletes them.\r\n';
				else if (command === 'unicode') output += '你好 · café · 🙂\r\n';
				else if (command === 'stty size') output += `${socket.rows} ${socket.cols}\r\n`;
				else if (command.startsWith('echo ')) output += `${command.slice(5)}\r\n`;
				else if (/^sleep \d+$/.test(command)) session.command = command;
				else if (command === 'clear') {
					output = '\x1b[2J\x1b[H';
					session.history = '';
				} else if (command) output += `Demo only: ${command}\r\n`;
				if (!session.command.startsWith('sleep ')) output += this.prompt(session);
			} else if (char === '\x7f' || char === '\b') {
				if (session.input) {
					session.input = [...session.input].slice(0, -1).join('');
					output += '\b \b';
				}
			} else if (char >= ' ' && session.input.length < 4096) {
				session.input += char;
				output += char;
			}
		}
		session.history = historyTail(session.history + output);
		this.save(registry);
		for (const attached of this.sockets) {
			if (attached.sessionId !== session.id) continue;
			attached.output(output);
			if (session.state === 'exited') {
				attached.control({ type: 'exit', code: 0 });
				attached.close();
			}
		}
	}
}

class DemoSocket implements ShellSocket {
	binaryType: BinaryType = 'arraybuffer';
	readyState = 0;
	bufferedAmount = 0;
	onopen: ShellSocket['onopen'] = null;
	onmessage: ShellSocket['onmessage'] = null;
	onerror: ShellSocket['onerror'] = null;
	onclose: ShellSocket['onclose'] = null;
	cols = 80;
	rows = 24;
	private decoder = new TextDecoder();
	constructor(
		private backend: DemoShellBackend,
		readonly sessionId: string
	) {}
	open() {
		if (this.readyState !== 0) return;
		this.readyState = 1;
		this.onopen?.call(this as unknown as WebSocket, new Event('open'));
		this.backend.redraw(this);
	}
	control(value: object) {
		this.receive(JSON.stringify(value));
	}
	output(text: string) {
		const bytes = encoder.encode(text);
		for (let offset = 0; offset < bytes.length; offset += 65536) {
			this.receive(bytes.slice(offset, offset + 65536).buffer);
		}
	}
	private receive(data: unknown) {
		if (this.readyState === 1)
			this.onmessage?.call(this as unknown as WebSocket, new MessageEvent('message', { data }));
	}
	send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
		if (this.readyState !== 1) return;
		if (typeof data === 'string') {
			const control = JSON.parse(data);
			if (control.type === 'resize') {
				this.cols = control.cols;
				this.rows = control.rows;
			}
		} else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
			const bytes =
				data instanceof ArrayBuffer
					? new Uint8Array(data)
					: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
			this.backend.input(this, this.decoder.decode(bytes, { stream: true }));
		}
	}
	close() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.backend.detach(this);
		this.onclose?.call(this as unknown as WebSocket, new CloseEvent('close'));
	}
}
