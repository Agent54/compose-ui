import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { removeServices, stopProjectWatch, stopServices } from '../src/lib/central/api.ts';
import type { UiState } from '../src/lib/central/types.ts';

const ui: UiState = {
	id: 'app',
	serverUrl: 'http://127.0.0.1:8094',
	apiVersion: '1.24',
	filter: '',
	sortBy: 'status',
	autoRefreshPaused: false,
	selectedProjectId: '',
	selectedContainerId: '',
	status: 'connected',
	statusDetail: ''
};
const project = { id: 'demo', path: '/work/compose.yaml' };

test('removing an orphaned service stops watch and retains its recorded path and identity', async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
	globalThis.fetch = (input, init) => {
		requests.push({
			url: String(input),
			method: init?.method,
			...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
		});
		return Promise.resolve(
			init?.method === 'DELETE'
				? Response.json({ message: 'Watch not found' }, { status: 404 })
				: Response.json({ ok: true })
		);
	};
	try {
		await removeServices(ui, project, ['deleted-web']);
		assert.deepEqual(requests, [
			{ url: 'http://127.0.0.1:8094/v1.24/watch/demo', method: 'DELETE' },
			{
				url: 'http://127.0.0.1:8094/v1.24/rm/demo',
				method: 'POST',
				body: { path: '/work/compose.yaml', force: true, stop: true, services: ['deleted-web'] }
			}
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('stopping a restarting service releases watch before requesting its stop', async () => {
	const originalFetch = globalThis.fetch;
	let watching = true;
	const requests: Array<{ url: string; method: string | undefined; body?: unknown }> = [];
	globalThis.fetch = (input, init) => {
		requests.push({
			url: String(input),
			method: init?.method,
			...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
		});
		if (init?.method === 'DELETE') {
			watching = false;
			return Promise.resolve(Response.json({ ok: true, watching: false }));
		}
		return Promise.resolve(
			watching
				? Response.json({ message: 'stop watch before modifying it' }, { status: 409 })
				: Response.json({ ok: true })
		);
	};

	try {
		await stopServices(ui, project, ['web']);
		assert.deepEqual(requests, [
			{ url: 'http://127.0.0.1:8094/v1.24/watch/demo', method: 'DELETE' },
			{
				url: 'http://127.0.0.1:8094/v1.24/stop/demo',
				method: 'POST',
				body: { path: '/work/compose.yaml', removeOrphans: true, services: ['web'] }
			}
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('stopping a project with no active watch still stops all its services', async () => {
	const originalFetch = globalThis.fetch;
	let stopBody: unknown;
	globalThis.fetch = (_, init) => {
		if (init?.method === 'DELETE') {
			return Promise.resolve(Response.json({ message: 'Watch not found' }, { status: 404 }));
		}
		stopBody = JSON.parse(String(init?.body));
		return Promise.resolve(Response.json({ ok: true }));
	};

	try {
		await stopServices(ui, project);
		assert.deepEqual(stopBody, { path: '/work/compose.yaml', removeOrphans: true });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('a watch-stop failure prevents a competing stop mutation and preserves the server error', async () => {
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = (_, init) => {
		requests += 1;
		assert.equal(init?.method, 'DELETE');
		return Promise.resolve(
			Response.json({ message: 'Watch cancellation failed' }, { status: 500 })
		);
	};

	try {
		await assert.rejects(stopServices(ui, project, ['web']), /Watch cancellation failed/);
		assert.equal(requests, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('stop failures remain visible after successfully stopping watch', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (_, init) =>
		Promise.resolve(
			init?.method === 'DELETE'
				? Response.json({ ok: true })
				: Response.json({ message: 'Container did not stop' }, { status: 500 })
		);

	try {
		await assert.rejects(stopServices(ui, project, ['web']), /Container did not stop/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('stopping watch uses only the watch endpoint and safely encodes the project', async () => {
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = (input, init) => {
		requests += 1;
		assert.equal(String(input), 'http://127.0.0.1:8094/v1.24/watch/demo%2Fweb');
		assert.equal(init?.method, 'DELETE');
		assert.equal(init.body, undefined);
		return Promise.resolve(Response.json({ ok: true }));
	};

	try {
		await stopProjectWatch(ui, { id: 'demo/web' });
		assert.equal(requests, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
