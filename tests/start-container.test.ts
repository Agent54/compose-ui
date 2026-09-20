import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { startContainer } from '../src/lib/central/api.ts';
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

test('starts one container by its engine ID', async () => {
	let requestUrl = '';
	let requestBody: Record<string, unknown> = {};
	const originalFetch = globalThis.fetch;

	globalThis.fetch = (input, init) => {
		requestUrl = String(input);
		requestBody = JSON.parse(String(init?.body));
		return Promise.resolve(Response.json({ ok: true }));
	};

	try {
		await startContainer(ui, { id: 'demo', path: '/work/compose.yaml' }, '9ebf88d60f06');
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.equal(requestUrl, 'http://127.0.0.1:8094/v1.24/start/demo/container');
	assert.deepEqual(requestBody, {
		path: '/work/compose.yaml',
		container: '9ebf88d60f06'
	});
});
