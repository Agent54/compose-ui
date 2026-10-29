import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ServiceActionTracker, type ServiceAction } from '../src/lib/central/action-state.ts';
import { startProject } from '../src/lib/central/api.ts';
import { initialUiState } from '../src/lib/central/sample-data.ts';
import {
	isProjectRestarting,
	projectPendingStatus,
	servicePendingStatus
} from '../src/lib/central/service-state.ts';

const start = (projectId: string, serviceId?: string): ServiceAction => ({
	kind: 'start',
	projectId,
	serviceId
});

test('different projects and sibling services submit requests before any earlier request completes', async () => {
	let active: ServiceAction[] = [];
	const tracker = new ServiceActionTracker((actions) => {
		active = actions;
	});
	const requests: string[] = [];
	const responses: Array<() => void> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (_, init) => {
		requests.push(JSON.parse(String(init?.body)).path);
		return new Promise((resolve) => {
			responses.push(() => resolve(Response.json({ ok: true })));
		});
	};
	const run = async (action: ServiceAction) => {
		const release = tracker.acquire(action);
		assert.ok(release);
		try {
			await startProject(initialUiState[0], `/${action.projectId}/${action.serviceId}.yaml`, false);
		} finally {
			release();
		}
	};
	try {
		const running = [
			run(start('demo', 'web')),
			run(start('demo', 'worker')),
			run(start('other', 'db'))
		];
		assert.equal(requests.length, 3);
		assert.equal(active.length, 3);
		// Finishing a later request must not clear the earlier requests' pending state.
		responses[2]();
		await running[2];
		assert.deepEqual(active, [start('demo', 'web'), start('demo', 'worker')]);
		responses[0]();
		responses[1]();
		await Promise.all(running);
		assert.deepEqual(active, []);
	} finally {
		responses.forEach((respond) => respond());
		globalThis.fetch = originalFetch;
	}
});

test('duplicate and overlapping project/container actions are rejected without blocking independent targets', () => {
	const tracker = new ServiceActionTracker(() => {});
	const release = tracker.acquire(start('demo', 'web'));
	assert.ok(release);
	assert.equal(tracker.acquire(start('demo', 'web')), null);
	assert.equal(tracker.acquire({ ...start('demo', 'web'), kind: 'restart' }), null);
	assert.equal(tracker.acquire(start('demo')), null);
	const sibling = tracker.acquire(start('demo', 'worker'));
	assert.ok(sibling);
	release();
	release();
	assert.equal(tracker.acquire(start('demo')), null);
	sibling();
	const project = tracker.acquire(start('demo'));
	assert.ok(project);
	assert.equal(tracker.acquire(start('demo', 'worker')), null);
	project();
});

test('every concurrent child stays pending until its own request finishes', () => {
	let active: ServiceAction[] = [];
	const tracker = new ServiceActionTracker((actions) => {
		active = actions;
	});
	const project = {
		id: 'demo',
		name: 'demo',
		state: 'running',
		statusLabel: 'running(2)'
	} as const;
	const web = {
		id: 'web',
		projectId: 'demo',
		projectName: 'demo',
		serviceName: 'web',
		state: 'running'
	} as const;
	const worker = { ...web, id: 'worker', serviceName: 'worker' };
	const finishWeb = tracker.acquire(start('demo', 'web'))!;
	const finishWorker = tracker.acquire(start('demo', 'worker'))!;
	assert.equal(servicePendingStatus(web, [], active), 'starting');
	assert.equal(servicePendingStatus(worker, [], active), 'starting');
	finishWeb();
	assert.equal(servicePendingStatus(web, [], active), '');
	assert.equal(servicePendingStatus(worker, [], active), 'starting');
	assert.equal(projectPendingStatus(project, [web, worker], [], active), 'starting');
	finishWorker();
	assert.equal(projectPendingStatus(project, [web, worker], [], active), '');
	const finishStart = tracker.acquire(start('demo', 'web'))!;
	const finishRestart = tracker.acquire({ ...start('demo', 'worker'), kind: 'restart' })!;
	assert.equal(isProjectRestarting(project, [web, worker], active), true);
	finishRestart();
	assert.equal(isProjectRestarting(project, [web, worker], active), false);
	finishStart();
});

test('closing the tracker prevents new work and ignores late completions', () => {
	let notifications = 0;
	const tracker = new ServiceActionTracker(() => {
		notifications++;
	});
	const release = tracker.acquire(start('demo'))!;
	tracker.close();
	const beforeCompletion = notifications;
	release();
	assert.equal(notifications, beforeCompletion);
	assert.equal(tracker.acquire(start('other')), null);
});
