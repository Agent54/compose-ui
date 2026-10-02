import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { loadProjectServices, refreshProjectsFromServer } from '../src/lib/central/api.ts';
import { isProjectRestarting, isServiceRestarting } from '../src/lib/central/service-state.ts';
import type { ComposeProject, ComposeService, UiState } from '../src/lib/central/types.ts';

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

const project: Pick<ComposeProject, 'id' | 'state' | 'statusLabel'> = {
	id: 'demo',
	state: 'running',
	statusLabel: 'running(2)'
};
const service: Pick<ComposeService, 'id' | 'projectId' | 'state'> = {
	id: 'demo:web-container',
	projectId: 'demo',
	state: 'restarting'
};

test('backend restarting states survive parsing even when active flags or running state lag', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (input) => {
		const url = String(input);
		if (url.includes('/ls?')) {
			return Promise.resolve(
				Response.json([{ Name: 'demo', Status: 'restarting(1)', running: true, active: true }])
			);
		}
		if (url.includes('/ps/demo?')) {
			return Promise.resolve(
				Response.json([
					{ ID: 'web-container', Service: 'web', State: 'restarting', Status: 'Restarting (1)' },
					{
						ID: 'worker-container',
						Service: 'worker',
						State: 'running',
						Status: 'Restarting (137)'
					}
				])
			);
		}
		return Promise.resolve(Response.json({ services: {} }));
	};

	try {
		const result = await refreshProjectsFromServer(ui);
		assert.equal(result.projects[0].state, 'restarting');
		const services = await loadProjectServices(ui, { id: 'demo', path: '/work/compose.yaml' });
		assert.deepEqual(
			services.map((entry) => entry.state),
			['restarting', 'restarting']
		);
		assert.equal(services[1].stateText, 'Restarting (137)');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('a restarting child marks its running parent and clears when the child recovers', () => {
	assert.equal(isProjectRestarting(project, [service]), true);
	assert.equal(isProjectRestarting(project, [{ ...service, state: 'running' }]), false);
	assert.equal(isProjectRestarting(project, [{ ...service, projectId: 'another' }]), false);
});

test('project summaries reflect restart counts even without loaded children', () => {
	assert.equal(
		isProjectRestarting({ ...project, statusLabel: 'running(1), restarting(1)' }, []),
		true
	);
	assert.equal(isProjectRestarting({ ...project, state: 'restarting' }, []), true);
	assert.equal(
		isProjectRestarting({ ...project, statusLabel: 'running(1), restarting(0)' }, []),
		false
	);
});

test('local service and project restarts propagate without marking unrelated nodes', () => {
	const runningService = { ...service, state: 'running' as const };
	const serviceAction = `restart:demo:${service.id}`;
	assert.equal(isServiceRestarting(runningService, serviceAction), true);
	assert.equal(isProjectRestarting(project, [], serviceAction), true);
	assert.equal(isServiceRestarting(runningService, 'restart:demo:project'), true);
	assert.equal(isServiceRestarting(runningService, 'restart:demo:other-service'), false);
	assert.equal(isProjectRestarting(project, [], 'restart:demo-other:project'), false);
	assert.equal(isProjectRestarting(project, [], 'start:demo:project'), false);
	assert.equal(isServiceRestarting(runningService), false);
	assert.equal(isServiceRestarting(service), true);
});

test('service requests carry all known Compose paths without losing URL characters', async () => {
	const paths = '/work/first & app/compose.yaml,/work/second/compose.yaml';
	const requests: URL[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (input) => {
		requests.push(new URL(String(input)));
		return Promise.resolve(Response.json({ services: {} }));
	};

	try {
		await loadProjectServices(ui, { id: 'demo', path: paths });
	} finally {
		globalThis.fetch = originalFetch;
	}

	const ps = requests.find((url) => url.pathname.endsWith('/ps/demo'));
	assert.ok(ps);
	assert.equal(ps.searchParams.get('path'), paths);
	assert.equal(ps.searchParams.get('all'), 'true');
});
