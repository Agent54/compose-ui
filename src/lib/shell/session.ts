import { shellApiBase, type ShellLaunch } from './launch';

export type ShellSession = {
	engine: 'dtach';
	id: string;
	number: number;
	name: string;
	socketName: string;
	command: string;
	cwd: string;
	shell: 'bash' | 'sh';
	state: 'running' | 'exited';
};
export type ShellSelection =
	| { mode: 'attach-last' | 'create' }
	| { mode: 'attach'; sessionId: string };
export type ShellAttachment = { session: ShellSession; token: string };
export type ShellSocket = Pick<
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
export interface ShellBackend {
	readonly kind: 'live' | 'demo';
	list(signal?: AbortSignal): Promise<ShellSession[]>;
	attach(
		selection: ShellSelection,
		cols: number,
		rows: number,
		signal: AbortSignal
	): Promise<ShellAttachment>;
	delete(id: string): Promise<void>;
	openSocket(attachment: ShellAttachment): ShellSocket;
}
export class ShellBackendUnavailable extends Error {}
export const SHELL_PROTOCOL = 'compose-shell-v2';
const validId = (value: unknown): value is string =>
	typeof value === 'string' && /^[\w-]{1,128}$/.test(value);

export function parseSession(value: unknown): ShellSession {
	if (!value || typeof value !== 'object') throw new Error('Invalid shell session metadata.');
	const session = value as ShellSession;
	if (
		session.engine !== 'dtach' ||
		!validId(session.id) ||
		!Number.isSafeInteger(session.number) ||
		session.number < 1 ||
		!['bash', 'sh'].includes(session.shell) ||
		!['running', 'exited'].includes(session.state)
	) {
		throw new Error('Invalid shell session metadata.');
	}
	for (const field of ['name', 'socketName', 'command', 'cwd'] as const) {
		if (
			typeof session[field] !== 'string' ||
			session[field].length > 4096 ||
			[...session[field]].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
		) {
			throw new Error('Invalid shell session metadata.');
		}
	}
	return {
		engine: 'dtach',
		id: session.id,
		number: session.number,
		name: session.name,
		socketName: session.socketName,
		command: session.command,
		cwd: session.cwd,
		shell: session.shell,
		state: session.state
	};
}

export class LiveShellBackend implements ShellBackend {
	readonly kind = 'live';
	private readonly apiBase: string;
	constructor(
		private launch: ShellLaunch,
		origin: string,
		private dependencies = {
			fetch: globalThis.fetch.bind(globalThis),
			socket: (url: string, protocols: string[]): ShellSocket => new WebSocket(url, protocols)
		}
	) {
		this.apiBase = shellApiBase(launch, origin);
	}

	private async request(url: string, init: RequestInit, signal?: AbortSignal) {
		const timeout = AbortSignal.timeout(init.method === 'POST' ? 30000 : 4000);
		try {
			const response = await this.dependencies.fetch(url, {
				...init,
				credentials: 'include',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout
			});
			if (
				([404, 405, 501].includes(response.status) &&
					new URL(url).pathname === new URL(this.apiBase).pathname) ||
				response.status >= 500
			) {
				throw new ShellBackendUnavailable(
					`The live shell backend is unavailable (HTTP ${response.status}).`
				);
			}
			if (!response.ok) {
				let message = '';
				try {
					const body = await response.json();
					if (typeof body.message === 'string') message = body.message.slice(0, 500);
				} catch {
					/* Keep HTTP reason. */
				}
				throw new Error(message || `Shell request failed (HTTP ${response.status}).`);
			}
			return response;
		} catch (error) {
			if (signal?.aborted) throw error;
			if (error instanceof TypeError || timeout.aborted)
				throw new ShellBackendUnavailable('The live shell backend could not be reached.');
			throw error;
		}
	}

	async list(signal?: AbortSignal) {
		const url = new URL(this.apiBase);
		url.searchParams.set('target', JSON.stringify(this.launch.target));
		const response = await this.request(url.href, { method: 'GET' }, signal);
		try {
			const body = await response.json();
			if (!Array.isArray(body.sessions) || body.sessions.length > 1000)
				throw new Error('Invalid session list.');
			const sessions = body.sessions.map(parseSession) as ShellSession[];
			if (new Set(sessions.map((session) => session.id)).size !== sessions.length)
				throw new Error('Duplicate session ID.');
			return sessions;
		} catch {
			throw new ShellBackendUnavailable(
				'This server does not support persistent shell sessions yet.'
			);
		}
	}

	async attach(selection: ShellSelection, cols: number, rows: number, signal: AbortSignal) {
		const response = await this.request(
			this.apiBase,
			{
				method: 'POST',
				body: JSON.stringify({
					engine: 'dtach',
					target: this.launch.target,
					...selection,
					shell: 'bash',
					fallbackShell: 'sh',
					startIfStopped: true,
					resumeIfPaused: true,
					term: 'xterm-256color',
					cols,
					rows
				})
			},
			signal
		);
		const body = await response.json();
		const session = parseSession(body.session);
		if (typeof body.token !== 'string' || !/^[\w-]{16,512}$/.test(body.token))
			throw new Error('The shell server returned an invalid connection ticket.');
		return { session, token: body.token };
	}

	async delete(id: string) {
		if (!validId(id)) throw new Error('Invalid session ID.');
		await this.request(`${this.apiBase}/${id}`, { method: 'DELETE' });
	}

	openSocket(attachment: ShellAttachment) {
		const url = new URL(`${this.apiBase}/${attachment.session.id}/stream`);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		return this.dependencies.socket(url.href, [SHELL_PROTOCOL, `ticket.${attachment.token}`]);
	}
}
