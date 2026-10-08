import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
	containerShellTarget,
	parseShellLaunch,
	shellApiBase,
	shellHref,
	type ShellLaunch
} from '../src/lib/shell/launch.ts';
import {
	LiveShellBackend,
	ShellBackendUnavailable,
	type ShellSession
} from '../src/lib/shell/session.ts';
import { DemoShellBackend } from '../src/lib/shell/demo.ts';
import { ShellTransport, type ShellStatus } from '../src/lib/shell/transport.ts';
import type { ComposeProject, ComposeService } from '../src/lib/central/types.ts';
import { reroute } from '../src/hooks.ts';

const launch: ShellLaunch = { serverUrl: '', apiVersion: '1.24', target: { kind: 'vm' } };
const origin = 'https://compose.local';
const encoder = new TextEncoder();
const session: ShellSession = {
	engine: 'dtach',
	id: 'session-1',
	number: 1,
	name: 'Build',
	socketName: 'session-1.sock',
	command: 'bash',
	cwd: '/home/demo',
	shell: 'bash',
	state: 'running'
};

class Socket {
	binaryType: BinaryType = 'arraybuffer';
	readyState = 0;
	bufferedAmount = 0;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	sent: (string | Uint8Array)[] = [];
	send(data: string | ArrayBufferView | ArrayBuffer | Blob) {
		assert(typeof data === 'string' || data instanceof Uint8Array);
		this.sent.push(typeof data === 'string' ? data : data.slice());
	}
	close() {
		this.readyState = 3;
		this.onclose?.(new CloseEvent('close'));
	}
	open() {
		this.readyState = 1;
		this.onopen?.(new Event('open'));
	}
	message(data: unknown) {
		this.onmessage?.(new MessageEvent('message', { data }));
	}
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function fixture(fetchOverride?: typeof fetch) {
	const socket = new Socket();
	const statuses: ShellStatus[] = [];
	const requests: { url: string; init?: RequestInit }[] = [];
	const output: Uint8Array[] = [];
	const writes: (() => void)[] = [];
	let socketUrl = '';
	let protocols: string[] = [];
	const backend = new LiveShellBackend(launch, origin, {
		fetch: (input, init) => {
			requests.push({ url: String(input), init });
			return fetchOverride
				? fetchOverride(input, init)
				: Promise.resolve(
						init?.method === 'DELETE'
							? new Response(null, { status: 204 })
							: init?.method === 'GET'
								? Response.json({ sessions: [session] })
								: Response.json({ session, token: 'single_use_ticket_123456' })
					);
		},
		socket: (url, offered) => {
			socketUrl = url;
			protocols = offered;
			return socket;
		}
	});
	const transport = new ShellTransport(
		backend,
		{
			cols: 100,
			rows: 30,
			write: (data, callback) => {
				output.push(data);
				writes.push(callback);
			}
		},
		(status) => statuses.push(status)
	);
	return {
		transport,
		backend,
		socket,
		statuses,
		requests,
		output,
		writes,
		get socketUrl() {
			return socketUrl;
		},
		get protocols() {
			return protocols;
		},
		async ready(shell = 'bash') {
			const pending = transport.connect();
			await tick();
			socket.open();
			socket.message(JSON.stringify({ type: 'ready', shell }));
			await pending;
		}
	};
}

test('static file links and rerouting preserve subpaths, exact replica and Compose path', () => {
	const target = containerShellTarget(
		{ id: 'demo', path: '/demo/compose.yml' } as ComposeProject,
		{
			containerId: 'replica-2',
			serviceName: 'web',
			containerName: 'demo-web-2',
			composePath: '/override/compose.yml'
		} as ComposeService
	);
	const url = new URL(shellHref('/control', launch, target), origin);
	assert.equal(url.pathname, '/control/shell/index.html');
	assert.equal(url.search, '');
	assert.deepEqual(parseShellLaunch(url.hash, origin).target, {
		kind: 'container',
		project: 'demo',
		service: 'web',
		containerId: 'replica-2',
		path: '/override/compose.yml',
		name: 'demo-web-2'
	});
	assert.equal(reroute({ url, fetch }), '/control/shell/');
	assert.equal(reroute({ url: new URL('/other/index.html', origin), fetch }), undefined);
	assert.equal(
		shellApiBase({ serverUrl: 'https://api.local/proxy/', apiVersion: 'v1.24' }, origin),
		'https://api.local/proxy/v1.24/shell/sessions'
	);
	assert.equal(
		parseShellLaunch(new URL(shellHref('', launch, target, true), origin).hash, origin).newSession,
		true
	);
});

test('launch parsing rejects unsafe settings and strips arbitrary command, user and environment fields', () => {
	for (const serverUrl of [
		'javascript:alert(1)',
		'https://user:pass@api.local',
		'https://api.local?key=secret'
	])
		assert.throws(() =>
			parseShellLaunch(`#${encodeURIComponent(JSON.stringify({ ...launch, serverUrl }))}`, origin)
		);
	assert.throws(() => parseShellLaunch('#invalid', origin), /invalid/);
	assert.throws(() => parseShellLaunch('', origin), /Open a shell/);
	assert.throws(() => shellApiBase({ ...launch, apiVersion: '../unversioned' }, origin), /version/);
	assert.throws(
		() =>
			parseShellLaunch(
				`#${encodeURIComponent(JSON.stringify({ ...launch, target: { kind: 'container' } }))}`,
				origin
			),
		/project/
	);
	assert.deepEqual(
		parseShellLaunch(
			`#${encodeURIComponent(JSON.stringify({ ...launch, command: 'evil', newSession: 'true', target: { kind: 'vm', user: 'root' } }))}`,
			origin
		),
		launch
	);
});

test('normal opening requests attach-last and keeps single-use tickets out of URLs', async () => {
	const f = fixture();
	await f.ready();
	assert.deepEqual(JSON.parse(String(f.requests[0].init?.body)), {
		engine: 'dtach',
		target: { kind: 'vm' },
		mode: 'attach-last',
		shell: 'bash',
		fallbackShell: 'sh',
		startIfStopped: true,
		resumeIfPaused: true,
		term: 'xterm-256color',
		cols: 100,
		rows: 30
	});
	assert.equal(f.socketUrl, 'wss://compose.local/v1.24/shell/sessions/session-1/stream');
	assert.deepEqual(f.protocols, ['compose-shell-v2', 'ticket.single_use_ticket_123456']);
	assert.equal(f.requests[0].init?.credentials, 'include');
	f.transport.dispose();
	assert(!f.requests.some((request) => request.init?.method === 'DELETE'));
});

test('list, create, select and explicit delete use distinct scoped operations', async () => {
	const f = fixture();
	assert.deepEqual(await f.backend.list(), [session]);
	assert.deepEqual(JSON.parse(new URL(f.requests[0].url).searchParams.get('target')!), {
		kind: 'vm'
	});
	await f.backend.attach({ mode: 'create' }, 80, 24, new AbortController().signal);
	await f.backend.attach(
		{ mode: 'attach', sessionId: session.id },
		80,
		24,
		new AbortController().signal
	);
	assert.equal(JSON.parse(String(f.requests[1].init?.body)).mode, 'create');
	assert.equal(JSON.parse(String(f.requests[2].init?.body)).sessionId, session.id);
	assert(!f.requests.some((request) => request.init?.method === 'DELETE'));
	await f.backend.delete(session.id);
	assert.equal(f.requests.at(-1)?.init?.method, 'DELETE');
	await assert.rejects(f.backend.delete('../all'), /Invalid/);
});

test('readiness gates input, bytes preserve Unicode and mouse reports, ACK follows terminal parsing', async () => {
	const f = fixture();
	const pending = f.transport.connect();
	await tick();
	f.socket.open();
	assert.equal(f.transport.input('do not replay'), false);
	assert.equal(f.socket.sent.length, 1);
	f.socket.message(JSON.stringify({ type: 'ready', shell: 'sh' }));
	await pending;
	assert.match(f.statuses.at(-1)!.message, /Bash unavailable/);
	assert.equal(f.transport.input('你好\r'), true);
	assert.deepEqual(f.socket.sent.at(-1), encoder.encode('你好\r'));
	f.transport.input('\xff\x80', true);
	assert.deepEqual(f.socket.sent.at(-1), new Uint8Array([255, 128]));
	const bytes = encoder.encode('\x1b[32mhi 🙂\x1b[0m');
	f.socket.message(bytes.buffer);
	assert.deepEqual(f.output[0], bytes);
	assert(!f.socket.sent.some((data) => typeof data === 'string' && data.includes('ack')));
	f.writes[0]();
	assert.deepEqual(JSON.parse(String(f.socket.sent.at(-1))), { type: 'ack', bytes: bytes.length });
	f.transport.resize(120, 40);
	assert.deepEqual(JSON.parse(String(f.socket.sent.at(-1))), {
		type: 'resize',
		cols: 120,
		rows: 40
	});
	f.socket.message(JSON.stringify({ type: 'exit', code: 0 }));
	assert.equal(f.transport.input('never sent'), false);
	assert.equal(f.statuses.at(-1)?.phase, 'closed');
	f.transport.dispose();
	assert(!f.requests.some((request) => request.init?.method === 'DELETE'));
});

test('paste frames and pending output stay bounded without deleting the persistent session', async () => {
	const f = fixture();
	await f.ready();
	f.transport.input('x'.repeat(40000));
	assert.deepEqual(
		f.socket.sent.filter((data) => data instanceof Uint8Array).map((data) => data.length),
		[16384, 16384, 7232]
	);
	for (let i = 0; i < 17; i++) f.socket.message(new ArrayBuffer(65536));
	assert.equal(f.output.length, 16);
	assert.match(f.statuses.at(-1)!.message, /too much output/);
	f.transport.dispose();
	assert(!f.requests.some((request) => request.init?.method === 'DELETE'));
});

test('unsupported or unreachable backends permit demo fallback; authorization failures remain visible', async () => {
	for (const status of [404, 405, 501, 503]) {
		const f = fixture(() => Promise.resolve(new Response('Not found', { status })));
		await assert.rejects(f.backend.list(), ShellBackendUnavailable);
	}
	await assert.rejects(
		fixture(() => Promise.reject(new TypeError('network'))).backend.list(),
		ShellBackendUnavailable
	);
	await assert.rejects(
		fixture(() => Promise.resolve(new Response('<html>Fallback</html>'))).backend.list(),
		ShellBackendUnavailable
	);
	await assert.rejects(
		fixture(() =>
			Promise.resolve(Response.json({ sessions: [{ ...session, engine: 'raw-pty' }] }))
		).backend.list(),
		ShellBackendUnavailable
	);
	for (const status of [401, 403]) {
		await assert.rejects(
			fixture(() =>
				Promise.resolve(Response.json({ message: 'Invalid identity' }, { status }))
			).backend.list(),
			(error: unknown) => error instanceof Error && !(error instanceof ShellBackendUnavailable)
		);
	}
});

test('late attachment, bad tickets, malformed frames and disconnects only detach', async () => {
	let resolve!: (response: Response) => void;
	const late = fixture(
		() =>
			new Promise((done) => {
				resolve = done;
			})
	);
	const pending = late.transport.connect();
	late.transport.dispose();
	resolve(Response.json({ session, token: 'single_use_ticket_123456' }));
	await pending;
	assert.equal(late.socketUrl, '');
	assert.equal(late.requests.length, 1);
	const invalid = fixture(() => Promise.resolve(Response.json({ session, token: 'bad.token' })));
	await assert.rejects(invalid.transport.connect(), /invalid connection ticket/);
	invalid.transport.dispose();
	for (const cause of ['frame', 'network']) {
		const f = fixture();
		await f.ready();
		if (cause === 'frame') f.socket.message('{broken');
		else f.socket.onerror?.(new Event('error'));
		f.transport.dispose();
		assert.equal(f.statuses.at(-1)?.phase, 'error');
		assert.equal(f.requests.length, 1);
	}
});

function demoStore() {
	const data = new Map<string, string>();
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		}
	};
}
test('demo replay preserves dense Unicode within protocol frame limits', async () => {
	const backend = new DemoShellBackend(launch, demoStore());
	const created = await backend.attach({ mode: 'create' }, 80, 24, signal());
	const first = backend.openSocket(created);
	await tick();
	for (let i = 0; i < 12; i++) first.send(encoder.encode(`echo ${'你好🙂'.repeat(600)}\r`));
	first.close();
	const frames: Uint8Array[] = [];
	const restored = backend.openSocket(
		await backend.attach({ mode: 'attach-last' }, 80, 24, signal())
	);
	const decoder = new TextDecoder();
	let output = '';
	restored.onmessage = (event) => {
		if (event.data instanceof ArrayBuffer) {
			frames.push(new Uint8Array(event.data));
			output += decoder.decode(event.data, { stream: true });
		}
	};
	await tick();
	restored.close();
	output += decoder.decode();
	assert(frames.length > 1);
	assert(frames.every((frame) => frame.length <= 65536));
	assert(output.includes('你好'));
	assert(!output.includes('\ufffd'));
});
const signal = () => new AbortController().signal;
test('demo sessions persist across backend instances, attach last, switch without recreation, and isolate targets', async () => {
	const storage = demoStore();
	const first = new DemoShellBackend(launch, storage);
	const one = await first.attach({ mode: 'attach-last' }, 80, 24, signal());
	const restored = new DemoShellBackend(launch, storage);
	assert.equal(
		(await restored.attach({ mode: 'attach-last' }, 80, 24, signal())).session.id,
		one.session.id
	);
	const two = await restored.attach({ mode: 'create' }, 80, 24, signal());
	assert.notEqual(one.session.socketName, two.session.socketName);
	assert.equal(two.session.number, 2);
	await restored.attach({ mode: 'attach', sessionId: one.session.id }, 80, 24, signal());
	assert.equal(
		(await first.attach({ mode: 'attach-last' }, 80, 24, signal())).session.id,
		one.session.id
	);
	assert.equal((await first.list()).length, 2);
	const container = new DemoShellBackend(
		{
			...launch,
			target: {
				kind: 'container',
				project: 'p',
				service: 's',
				path: '/c.yml',
				name: 's',
				containerId: 'c'
			}
		},
		storage
	);
	assert.equal((await container.list()).length, 0);
});

test('demo command/cwd updates, detach persistence, explicit delete and exit retention match the contract', async () => {
	const backend = new DemoShellBackend(launch, demoStore());
	const attachment = await backend.attach({ mode: 'create' }, 80, 24, signal());
	const socket = backend.openSocket(attachment);
	const output: string[] = [];
	socket.onmessage = (event) => {
		if (event.data instanceof ArrayBuffer) output.push(new TextDecoder().decode(event.data));
	};
	await tick();
	socket.send(encoder.encode('cd /var/log\r'));
	socket.send(encoder.encode('sleep 600\r'));
	assert.equal((await backend.list())[0].cwd, '/var/log');
	assert.equal((await backend.list())[0].command, 'sleep 600');
	socket.close();
	assert.equal((await backend.list()).length, 1);
	const again = backend.openSocket(await backend.attach({ mode: 'attach-last' }, 80, 24, signal()));
	await tick();
	again.send(encoder.encode('\x03exit\r'));
	assert.equal((await backend.list())[0].state, 'exited');
	await assert.rejects(backend.attach({ mode: 'attach-last' }, 80, 24, signal()), /exited/);
	assert.equal((await backend.list()).length, 1);
	await backend.delete(attachment.session.id);
	assert.equal((await backend.list()).length, 0);
	assert(output.join('').includes('Demo shell'));
});
