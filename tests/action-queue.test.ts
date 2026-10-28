import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ServiceActionQueue, type ServiceAction } from '../src/lib/central/action-queue.ts';
import { servicePendingStatus } from '../src/lib/central/service-state.ts';

const start = (projectId: string, serviceId?: string): ServiceAction => ({
	kind: 'start',
	projectId,
	serviceId
});

test('starts clicked during a pending build wait in FIFO order, including sibling services', async () => {
	let active: ServiceAction | null = null;
	let pending: ServiceAction[] = [];
	const queue = new ServiceActionQueue((current, waiting) => {
		active = current;
		pending = waiting;
	});
	const releaseWeb = await queue.acquire(start('demo', 'web'));
	assert.ok(releaseWeb);
	const worker = queue.acquire(start('demo', 'worker'));
	const database = queue.acquire(start('other', 'db'));
	assert.deepEqual(active, start('demo', 'web'));
	assert.deepEqual(pending, [start('demo', 'worker'), start('other', 'db')]);
	let workerStarted = false;
	void worker.then(() => {
		workerStarted = true;
	});
	await Promise.resolve();
	assert.equal(workerStarted, false);
	releaseWeb();
	const releaseWorker = await worker;
	assert.ok(releaseWorker);
	assert.deepEqual(active, start('demo', 'worker'));
	assert.deepEqual(pending, [start('other', 'db')]);
	// A repeated completion must not release the next action's slot.
	releaseWeb();
	assert.deepEqual(active, start('demo', 'worker'));
	releaseWorker();
	const releaseDatabase = await database;
	assert.ok(releaseDatabase);
	releaseDatabase();
	assert.equal(active, null);
	assert.deepEqual(pending, []);
});

test('duplicate and overlapping project/service requests are suppressed across start modes', async () => {
	const queue = new ServiceActionQueue(() => {});
	const release = await queue.acquire(start('demo', 'web'));
	assert.ok(release);
	assert.equal(await queue.acquire(start('demo', 'web')), null);
	assert.equal(await queue.acquire({ ...start('demo', 'web'), kind: 'up-no-build' }), null);
	assert.equal(await queue.acquire(start('demo')), null);
	const other = queue.acquire(start('other'));
	assert.equal(await queue.acquire(start('other', 'db')), null);
	release();
	(await other)?.();
});

test('a failed action releases the next start and unmount cancels remaining queued work', async () => {
	const queue = new ServiceActionQueue(() => {});
	const release = await queue.acquire({ ...start('demo'), kind: 'stop' });
	assert.ok(release);
	const worker = queue.acquire(start('other', 'worker'));
	await assert.rejects(async () => {
		try {
			throw new Error('Build failed');
		} finally {
			release();
		}
	}, /Build failed/);
	const releaseWorker = await worker;
	assert.ok(releaseWorker);
	const cancelled = queue.acquire(start('third'));
	queue.close();
	assert.equal(await cancelled, null);
	assert.equal(await queue.acquire(start('fourth')), null);
	releaseWorker();
});

test('queued labels apply only to the selected service or all services in a queued project', () => {
	const service = {
		id: 'worker',
		projectId: 'demo',
		projectName: 'demo',
		serviceName: 'worker',
		state: 'uncreated'
	} as const;
	assert.equal(
		servicePendingStatus(service, [], 'start:demo:web', [start('demo', 'worker')]),
		'queued'
	);
	assert.equal(servicePendingStatus(service, [], null, [start('other', 'worker')]), '');
	assert.equal(servicePendingStatus(service, [], null, [start('demo', 'web')]), '');
	assert.equal(servicePendingStatus(service, [], null, [start('demo')]), 'queued');
	assert.equal(servicePendingStatus(service, [], 'start:demo:worker', []), 'starting');
	assert.equal(servicePendingStatus(service, [], 'unpause:demo:worker', []), 'starting');
});
