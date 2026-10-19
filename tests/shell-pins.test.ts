/// <reference lib="dom" />
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CommandPins } from '../src/lib/shell/pins.ts';

function memoryStorage() {
	const data = new Map<string, string>();
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		}
	};
}
const first = { text: 'echo 你好\npwd', cwd: '/workspace', createdAt: 123 };
const second = { text: 'ls -la', cwd: '/var/log', createdAt: 456 };

test('pins save complete commands independently of history and survive a fresh instance', () => {
	const storage = memoryStorage();
	const pins = new CommandPins('vm-demo', storage);
	assert.deepEqual(pins.list(), []);
	pins.toggle(first);
	pins.toggle(second);
	const restored = new CommandPins('vm-demo', storage).list();
	assert.deepEqual(
		restored.map(({ text, cwd, createdAt }) => ({ text, cwd, createdAt })),
		[second, first]
	);
	assert(restored.every((pin) => Number.isFinite(pin.pinnedAt)));
	assert(!storage.getItem(pins.key)?.includes('sessionId'));
});

test('pins are unique per exact command, can be unpinned, and isolate target/backend scopes', () => {
	const storage = memoryStorage();
	const pins = new CommandPins('vm-live', storage);
	pins.toggle(first);
	assert.deepEqual(new CommandPins('vm-demo', storage).list(), []);
	assert.deepEqual(new CommandPins('container-live', storage).list(), []);
	assert.deepEqual(pins.toggle({ ...first, cwd: '/elsewhere', createdAt: 999 }), []);
	assert.deepEqual(new CommandPins('vm-live', storage).list(), []);
});

test('mutations merge another tab’s saved pins instead of overwriting a stale list', () => {
	const storage = memoryStorage();
	const tabA = new CommandPins('vm', storage);
	const tabB = new CommandPins('vm', storage);
	tabA.list();
	tabB.toggle(first);
	assert.deepEqual(
		tabA.toggle(second).map((pin) => pin.text),
		[second.text, first.text]
	);
	assert.deepEqual(
		tabB.toggle(first).map((pin) => pin.text),
		[second.text]
	);
});

test('malformed storage is not silently overwritten and invalid records cannot break the menu', () => {
	const storage = memoryStorage();
	const pins = new CommandPins('vm', storage);
	storage.setItem(pins.key, 'broken JSON');
	assert.throws(() => pins.toggle(first));
	assert.equal(storage.getItem(pins.key), 'broken JSON');
	storage.setItem(
		pins.key,
		JSON.stringify([
			null,
			{},
			{ ...first, createdAt: 1e20, pinnedAt: 2 },
			{ ...first, pinnedAt: 2, command: 'injected' },
			{ ...first, pinnedAt: 3 }
		])
	);
	assert.deepEqual(pins.list(), [{ ...first, pinnedAt: 2 }]);
});

test('a storage quota failure preserves previously saved favorites', () => {
	const storage = memoryStorage();
	const pins = new CommandPins('vm', storage);
	pins.toggle(first);
	const full = new CommandPins('vm', {
		getItem: storage.getItem,
		setItem: () => {
			throw new Error('Quota exceeded');
		}
	});
	assert.throws(() => full.toggle(second), /Quota/);
	assert.deepEqual(
		pins.list().map((pin) => pin.text),
		[first.text]
	);
});
