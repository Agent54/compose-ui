import type { ShellLaunch } from './launch';
import {
	DemoInputDecoder,
	demoCursor,
	demoLine,
	editDemoLine,
	redrawDemoLine,
	type DemoLine
} from './demo-input';
import {
	parseSession,
	type ShellAttachment,
	type ShellBackend,
	type ShellSelection,
	type ShellSession,
	type ShellSocket
} from './session';

type DemoSession = ShellSession & DemoLine & { history: string };
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
					sessions: value.sessions.map((item: DemoSession) => {
						let history = typeof item.history === 'string' ? historyTail(item.history) : '';
						// Older demo records included the unfinished input in the transcript.
						if (!Array.isArray(item.commands) && item.input && history.endsWith(item.input))
							history = history.slice(0, -item.input.length);
						return {
							...parseSession({ ...item, engine: item.engine ?? 'dtach' }),
							...demoLine(item),
							history
						};
					})
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
				...demoLine(),
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
		socket.output(
			session.history + session.input + demoCursor(session, this.prompt(session), socket.cols)
		);
	}
	input(socket: DemoSocket, text: string) {
		const registry = this.read();
		const session = registry.sessions.find((item) => item.id === socket.sessionId);
		if (!session || session.state !== 'running') {
			socket.close();
			return;
		}
		let output = '';
		for (const input of socket.keyboard.feed(text)) {
			const key = 'key' in input ? input.key : undefined;
			if (key === 'interrupt') {
				const before = { input: session.input, cursor: session.cursor };
				session.cursor = Array.from(session.input).length;
				if (before.cursor !== session.cursor)
					output += redrawDemoLine(before, session, this.prompt(session), socket.cols);
				session.history = historyTail(
					session.history + session.input + `^C\r\n${this.prompt(session)}`
				);
				session.input = '';
				session.cursor = 0;
				session.historyIndex = session.commands.length;
				session.draft = '';
				session.command = 'bash';
				output += `^C\r\n${this.prompt(session)}`;
			} else if (session.command.startsWith('sleep ')) continue;
			else if (key === 'enter' || (key === 'eof' && !session.input)) {
				if (key === 'eof') session.input = 'exit';
				const command = session.input.trim();
				const before = { input: session.input, cursor: session.cursor };
				session.cursor = Array.from(session.input).length;
				if (key !== 'eof' && before.cursor !== session.cursor)
					output += redrawDemoLine(before, session, this.prompt(session), socket.cols);
				session.history = historyTail(session.history + session.input + '\r\n');
				if (command) session.commands.push(command);
				session.input = '';
				session.cursor = 0;
				session.historyIndex = session.commands.length;
				session.draft = '';
				output += '\r\n';
				if (command === 'exit') {
					session.state = 'exited';
					session.command = '';
					break;
				}
				let result = '';
				if (command === 'pwd') result += `${session.cwd}\r\n`;
				else if (command.startsWith('cd ')) {
					const path = command.slice(3).trim();
					const resolved: string[] = [];
					for (const part of (path.startsWith('/') ? path : `${session.cwd}/${path}`).split('/')) {
						if (part === '..') resolved.pop();
						else if (part && part !== '.') resolved.push(part);
					}
					session.cwd = `/${resolved.join('/')}`;
				} else if (command === 'cd') session.cwd = '/home/demo';
				else if (command === 'ls') result += 'demo.txt  projects/  logs/\r\n';
				else if (command === 'help')
					result +=
						'Demo commands: pwd, cd PATH, ls, echo TEXT, unicode, stty size, sleep N, clear, exit\r\nSessions persist in this browser. Close session explicitly deletes them.\r\n';
				else if (command === 'unicode') result += '你好 · café · 🙂\r\n';
				else if (command === 'stty size') result += `${socket.rows} ${socket.cols}\r\n`;
				else if (command.startsWith('echo ')) result += `${command.slice(5)}\r\n`;
				else if (/^sleep \d+$/.test(command)) session.command = command;
				else if (command === 'clear') {
					result = '\x1b[2J\x1b[H';
					session.history = '';
				} else if (command) result += `Demo only: ${command}\r\n`;
				if (!session.command.startsWith('sleep ')) result += this.prompt(session);
				output += result;
				session.history = historyTail(session.history + result);
			} else if (key === 'clear') {
				output += `\x1b[2J\x1b[H${this.prompt(session)}${session.input}${demoCursor(session, this.prompt(session), socket.cols)}`;
				session.history = this.prompt(session);
			} else {
				const before = { input: session.input, cursor: session.cursor };
				editDemoLine(session, input);
				if (before.input === session.input && before.cursor === session.cursor) continue;
				output +=
					'text' in input && before.cursor === Array.from(before.input).length
						? session.input.slice(before.input.length)
						: redrawDemoLine(before, session, this.prompt(session), socket.cols);
			}
		}
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
	readonly keyboard = new DemoInputDecoder();
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
