import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { loadSystemInfo, refreshProjectsFromServer, startProject } from '../src/lib/central/api.ts';
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

test('snapshot deadlines cancel stalled headers and bodies with an actionable error', async () => {
	const originalFetch = globalThis.fetch;
	const signals: AbortSignal[] = [];
	globalThis.fetch = (input, init) => {
		const signal = init?.signal;
		assert(signal);
		signals.push(signal);
		if (String(input).endsWith('/system')) {
			return Promise.resolve(
				new Response(
					new ReadableStream({
						start(controller) {
							signal.addEventListener('abort', () => controller.error(signal.reason), {
								once: true
							});
						}
					})
				)
			);
		}
		return new Promise((_, reject) => {
			signal.addEventListener('abort', () => reject(signal.reason), { once: true });
		});
	};

	try {
		await Promise.all([
			assert.rejects(
				refreshProjectsFromServer(ui),
				/Listing projects timed out after 5 seconds.*VM may be busy/
			),
			assert.rejects(
				loadSystemInfo(ui),
				/Loading \/system timed out after 5 seconds.*VM may be busy/
			)
		]);
		assert.equal(signals.length, 2);
		assert(signals.every((signal) => signal.aborted));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('build requests are not cut off by the snapshot deadline', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (_, init) => {
		assert.equal(init?.method, 'POST');
		assert.equal(init?.signal, undefined);
		return Promise.resolve(Response.json({ ok: true }));
	};
	try {
		await startProject(ui, '/stacks/demo/compose.yaml', false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
