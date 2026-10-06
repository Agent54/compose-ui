import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
	containerShellTarget,
	parseShellLaunch,
	shellApiBase,
	shellHref,
	type ShellLaunch
} from '../src/lib/shell/launch.ts';
import { ShellTransport, type ShellStatus } from '../src/lib/shell/transport.ts';
import type { ComposeProject, ComposeService } from '../src/lib/central/types.ts';

const launch: ShellLaunch = { serverUrl: '', apiVersion: '1.24', target: { kind: 'vm' } };
const origin = 'https://compose.local';
const encoder = new TextEncoder();

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

function fixture(fetchOverride?: typeof fetch) {
	const socket = new Socket();
	const statuses: ShellStatus[] = [];
	const requests: { url: string; init?: RequestInit }[] = [];
	const output: Uint8Array[] = [];
	const writes: (() => void)[] = [];
	let socketUrl = '';
	let protocols: string[] = [];
	const transport = new ShellTransport(
		launch,
		origin,
		{
			cols: 100,
			rows: 30,
			write: (data, callback) => {
				output.push(data);
				writes.push(callback);
			}
		},
		(status) => statuses.push(status),
		{
			fetch: (input, init) => {
				requests.push({ url: String(input), init });
				return fetchOverride
					? fetchOverride(input, init)
					: Promise.resolve(
							init?.method === 'DELETE'
								? new Response(null, { status: 204 })
								: Response.json({ id: 'session-1', token: 'single_use_ticket_123456' })
						);
			},
			socket: (url, offered) => {
				socketUrl = url;
				protocols = offered;
				return socket;
			}
		}
	);
	return {
		transport,
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
		}
	};
}

test('standalone links preserve subpath deployments, replica identity and compose path', () => {
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
	assert.equal(url.pathname, '/control/shell/');
	assert.equal(url.search, '');
	assert.deepEqual(parseShellLaunch(url.hash, origin).target, {
		kind: 'container',
		project: 'demo',
		service: 'web',
		containerId: 'replica-2',
		path: '/override/compose.yml',
		name: 'demo-web-2'
	});
	assert.equal(
		shellApiBase({ serverUrl: 'https://api.local/proxy/', apiVersion: 'v1.24' }, origin),
		'https://api.local/proxy/v1.24/shell/sessions'
	);
});

test('launch parsing rejects unsafe URLs and incomplete targets, and strips injected options', () => {
	for (const serverUrl of [
		'javascript:alert(1)',
		'https://user:pass@api.local',
		'https://api.local?key=secret'
	]) {
		assert.throws(() =>
			parseShellLaunch(`#${encodeURIComponent(JSON.stringify({ ...launch, serverUrl }))}`, origin)
		);
	}
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
			`#${encodeURIComponent(JSON.stringify({ ...launch, command: 'evil', target: { kind: 'vm', command: 'evil' } }))}`,
			origin
		),
		launch
	);
});

test('session creation requests Bash and atomic start/resume, with tickets outside URLs', async () => {
	const f = fixture();
	try {
		await f.transport.connect();
		assert.deepEqual(JSON.parse(String(f.requests[0].init?.body)), {
			target: { kind: 'vm' },
			shell: 'bash',
			fallbackShell: 'sh',
			startIfStopped: true,
			resumeIfPaused: true,
			term: 'xterm-256color',
			cols: 100,
			rows: 30
		});
		assert.equal(f.socketUrl, 'wss://compose.local/v1.24/shell/sessions/session-1/stream');
		assert.deepEqual(f.protocols, ['compose-shell-v1', 'ticket.single_use_ticket_123456']);
		assert.equal(f.requests[0].init?.credentials, 'include');
	} finally {
		f.transport.dispose();
	}
});

test('input is gated by readiness, UTF-8 and binary input are preserved, output ACK waits for parsing', async () => {
	const f = fixture();
	try {
		await f.transport.connect();
		f.socket.open();
		f.transport.input('do not replay');
		assert.equal(f.socket.sent.length, 1); // initial size only
		f.socket.message(JSON.stringify({ type: 'ready', shell: 'sh' }));
		assert.match(f.statuses.at(-1)!.message, /Bash unavailable/);
		f.transport.input('你好\r');
		assert.deepEqual(f.socket.sent.at(-1), encoder.encode('你好\r'));
		f.transport.input('\xff\x80', true);
		assert.deepEqual(f.socket.sent.at(-1), new Uint8Array([255, 128]));
		const bytes = encoder.encode('\x1b[32mhi 🙂\x1b[0m');
		f.socket.message(bytes.buffer);
		assert.deepEqual(f.output[0], bytes);
		assert(!f.socket.sent.some((data) => typeof data === 'string' && data.includes('ack')));
		f.writes[0]();
		assert.deepEqual(JSON.parse(String(f.socket.sent.at(-1))), {
			type: 'ack',
			bytes: bytes.length
		});
		f.transport.resize(120, 40);
		assert.deepEqual(JSON.parse(String(f.socket.sent.at(-1))), {
			type: 'resize',
			cols: 120,
			rows: 40
		});
		f.socket.message(JSON.stringify({ type: 'exit', code: 0 }));
		const sent = f.socket.sent.length;
		f.transport.input('never sent');
		assert.equal(f.socket.sent.length, sent);
		assert.equal(f.statuses.at(-1)?.phase, 'closed');
		assert.equal(f.requests.at(-1)?.init?.method, 'DELETE');
	} finally {
		f.transport.dispose();
	}
});

test('large paste uses bounded frames and unacknowledged output is capped', async () => {
	const f = fixture();
	try {
		await f.transport.connect();
		f.socket.open();
		f.socket.message(JSON.stringify({ type: 'ready', shell: 'bash' }));
		f.transport.input('x'.repeat(40000));
		assert.deepEqual(
			f.socket.sent.filter((data) => data instanceof Uint8Array).map((data) => data.length),
			[16384, 16384, 7232]
		);
		for (let i = 0; i < 17; i++) f.socket.message(new ArrayBuffer(65536));
		assert.equal(f.output.length, 16);
		assert.equal(f.statuses.at(-1)?.phase, 'error');
		assert.match(f.statuses.at(-1)!.message, /too much output/);
	} finally {
		f.transport.dispose();
	}
});

test('a missing backend gives an actionable error without attempting a WebSocket', async () => {
	const f = fixture(() => Promise.resolve(new Response('Not found', { status: 404 })));
	await f.transport.connect();
	assert.equal(f.socketUrl, '');
	assert.match(f.statuses.at(-1)!.message, /does not support interactive shells/);
	assert.equal(f.statuses.at(-1)?.phase, 'error');
	f.transport.dispose();
});

test('disposing during creation cleans up a late session without opening its socket', async () => {
	let resolve!: (response: Response) => void;
	const f = fixture((_, init) =>
		init?.method === 'DELETE'
			? Promise.resolve(new Response(null, { status: 204 }))
			: new Promise((done) => {
					resolve = done;
				})
	);
	const pending = f.transport.connect();
	f.transport.dispose();
	resolve(Response.json({ id: 'late-session', token: 'single_use_ticket_123456' }));
	await pending;
	assert.equal(f.socketUrl, '');
	assert.equal(f.requests.at(-1)?.url, `${origin}/v1.24/shell/sessions/late-session`);
	assert.equal(f.requests.at(-1)?.init?.method, 'DELETE');
	assert.equal(f.statuses.length, 1);
});

test('invalid tickets, malformed control frames and network errors release sessions once', async () => {
	const invalid = fixture((_, init) =>
		Promise.resolve(
			init?.method === 'DELETE'
				? new Response(null, { status: 204 })
				: Response.json({ id: 'session-1', token: 'bad.token' })
		)
	);
	await invalid.transport.connect();
	assert.equal(invalid.socketUrl, '');
	assert.match(invalid.statuses.at(-1)!.message, /invalid connection ticket/);
	invalid.transport.dispose();
	assert.equal(invalid.requests.filter((request) => request.init?.method === 'DELETE').length, 1);
	for (const cause of ['frame', 'network']) {
		const f = fixture();
		await f.transport.connect();
		f.socket.open();
		if (cause === 'frame') f.socket.message('{broken');
		else f.socket.onerror?.(new Event('error'));
		f.transport.dispose();
		assert.equal(f.statuses.at(-1)?.phase, 'error');
		assert.equal(f.requests.filter((request) => request.init?.method === 'DELETE').length, 1);
	}
});
