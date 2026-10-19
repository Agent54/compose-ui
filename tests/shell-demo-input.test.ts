import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DemoShellBackend } from '../src/lib/shell/demo.ts';
import type { ShellLaunch } from '../src/lib/shell/launch.ts';

const launch: ShellLaunch = { serverUrl: '', apiVersion: '1.24', target: { kind: 'vm' } };
const encoder = new TextEncoder();
const signal = () => new AbortController().signal;
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

async function fixture() {
	const data = new Map<string, string>();
	const storage = {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		}
	};
	const backend = new DemoShellBackend(launch, storage);
	const attachment = await backend.attach({ mode: 'create' }, 80, 24, signal());
	const socket = backend.openSocket(attachment);
	const output: string[] = [];
	const decoder = new TextDecoder();
	socket.onmessage = (event) => {
		if (event.data instanceof ArrayBuffer)
			output.push(decoder.decode(event.data, { stream: true }));
	};
	await tick();
	return {
		backend,
		storage,
		data,
		socket,
		output,
		id: attachment.session.id,
		send: (text: string) => socket.send(encoder.encode(text)),
		line: () => backend.get(attachment.session.id)!
	};
}

test('terminal arrows recall history without executing and Down restores the unfinished draft', async () => {
	const f = await fixture();
	f.send('echo one\recho two\recho unfinished');
	const count = f.line().commands.length;
	// A key sequence may arrive in separate WebSocket frames.
	f.send('\x1b');
	f.send('[');
	f.send('A');
	assert.equal(f.line().input, 'echo two');
	f.send('\x1b[A\x1b[A');
	assert.equal(f.line().input, 'echo one');
	f.send('\x1b[B\x1b[B\x1b[B');
	assert.equal(f.line().input, 'echo unfinished');
	assert.equal(f.line().commands.length, count);
	f.send('\x1bOA\r');
	assert.equal(f.line().commands.at(-1), 'echo two');
	assert(f.output.join('').endsWith('two\r\n\x1b[32mdemo\x1b[0m:/home/demo$ '));
	f.socket.close();
});

test('terminal Left/Right, Home/End, Delete and Backspace edit at the cursor', async () => {
	const f = await fixture();
	f.send('echo hxllo\x1b[H' + '\x1b[C'.repeat(6) + '\x1b[3~e');
	assert.equal(f.line().input, 'echo hello');
	f.send('\x1bOF\x7fo\r');
	assert.equal(f.line().commands.at(-1), 'echo hello');
	assert(f.output.join('').includes('hello\r\n'));
	f.send('echo 你🙂\x1b[D\x7f好');
	assert.equal(f.line().input, 'echo 好🙂');
	f.send('\r');
	assert(f.output.join('').includes('好🙂\r\n'));
	f.socket.close();
});

test('terminal history and cursor survive reattachment and remain scoped to their session', async () => {
	const f = await fixture();
	f.send('echo saved\recho draft\x1b[A\x1b[D');
	f.socket.close();
	const restored = new DemoShellBackend(launch, f.storage);
	const attachment = await restored.attach({ mode: 'attach-last' }, 80, 24, signal());
	const socket = restored.openSocket(attachment);
	let replay = '';
	socket.onmessage = (event) => {
		if (event.data instanceof ArrayBuffer) replay += new TextDecoder().decode(event.data);
	};
	await tick();
	assert.equal(restored.get(f.id)?.input, 'echo saved');
	assert.equal(restored.get(f.id)?.cursor, 9);
	assert(!restored.get(f.id)?.history.includes('\x1b[J'));
	assert(replay.includes('echo saved\r\nsaved\r\n'));
	socket.send(encoder.encode('\x1b[B'));
	assert.equal(restored.get(f.id)?.input, 'echo draft');
	const other = await restored.attach({ mode: 'create' }, 80, 24, signal());
	assert.deepEqual(restored.get(other.session.id)?.commands, []);
	socket.close();
});

test('unsupported key sequences do not print or enter commands, including while a job is running', async () => {
	const f = await fixture();
	f.send('\x1b[A\x1b[B\x1b[99~\x1b[1;5D');
	assert.equal(f.line().input, '');
	f.send('\x1b[' + '1;'.repeat(500) + '~echo safe');
	assert.equal(f.line().input, 'echo safe');
	f.send('\x15sleep 600\r\x1b[A\x1b[B');
	assert.equal(f.line().input, '');
	assert.equal(f.line().command, 'sleep 600');
	f.send('\x03\x1b[A');
	assert.equal(f.line().input, 'sleep 600');
	assert.equal(f.line().command, 'bash');
	f.socket.close();
});

test('editing shortcuts preserve the suffix, cancel safely and only exit on Ctrl-D at an empty prompt', async () => {
	const f = await fixture();
	f.send('echo left right\x1b[H' + '\x1b[C'.repeat(10) + '\x15');
	assert.equal(f.line().input, 'right');
	f.send('\x1b[F\x17echo draft\x1b[H\x1b[C\x0b');
	assert.equal(f.line().input, 'e');
	f.send('\x03\x04');
	assert.equal(f.line().state, 'exited');
	assert.deepEqual(f.line().commands, ['exit']);
});

test('legacy demo records migrate unfinished input without duplicating it on replay', async () => {
	const f = await fixture();
	f.socket.close();
	const [key, value] = [...f.data][0];
	const record = JSON.parse(value);
	const old = record.sessions[0];
	delete old.commands;
	delete old.cursor;
	delete old.historyIndex;
	delete old.draft;
	old.input = 'echo legacy';
	old.history += old.input;
	f.storage.setItem(key, JSON.stringify(record));
	const restored = new DemoShellBackend(launch, f.storage);
	const socket = restored.openSocket(
		await restored.attach({ mode: 'attach-last' }, 80, 24, signal())
	);
	let output = '';
	socket.onmessage = (event) => {
		if (event.data instanceof ArrayBuffer) output += new TextDecoder().decode(event.data);
	};
	await tick();
	assert.equal(output.match(/echo legacy/g)?.length, 1);
	socket.send(encoder.encode('\x15echo migrated\r\x1b[A'));
	assert.equal(restored.get(f.id)?.input, 'echo migrated');
	socket.close();
});
