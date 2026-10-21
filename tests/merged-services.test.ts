import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { loadBuilds, startProject } from '../src/lib/central/api.ts';
import { buildTitle, latestBuildFailure, mergeBuilds } from '../src/lib/central/build-state.ts';
import { composeActionPaths, composeStartupPaths } from '../src/lib/central/service-actions.ts';
import { servicePendingStatus } from '../src/lib/central/service-state.ts';
import type { ComposeBuild, UiState } from '../src/lib/central/types.ts';

const project = {
	path: '/stacks/darc/compose.yaml,/stacks/code/compose.yaml,/stacks/darc/compose.override.yaml'
};
const service = {
	id: 'darc:vscode',
	projectId: 'darc',
	projectName: 'darc',
	serviceName: 'vscode',
	state: 'uncreated' as const,
	composePath: '/stacks/code/compose.yaml,/stacks/code/compose.override.yaml'
};
const build: ComposeBuild = {
	id: '2',
	projectId: 'darc',
	projectName: 'darc',
	serviceNames: ['vscode'],
	status: 'running',
	startedAt: '2026-10-22T00:00:00Z',
	finishedAt: null,
	success: null,
	streamUrl: '/builds/2/stream'
};
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

test('merged startup keeps base and override files together for each directory', () => {
	assert.deepEqual(composeActionPaths(project), [
		'/stacks/darc/compose.yaml,/stacks/darc/compose.override.yaml',
		'/stacks/code/compose.yaml'
	]);
	assert.deepEqual(composeActionPaths(project, service), [service.composePath]);
	assert.deepEqual(composeActionPaths({ path: '' }), []);
	assert.deepEqual(
		composeActionPaths({ path: 'compose.yaml,compose.override.yaml,compose.yaml' }),
		['compose.yaml,compose.override.yaml']
	);
});

test('a parent start animates every merged child and a child start stays scoped', () => {
	const sibling = { ...service, id: 'darc:main', serviceName: 'darc' };
	for (const kind of ['start', 'up-no-build', 'watching', 'stop', 'remove', 'restart']) {
		for (const child of [service, sibling]) {
			assert.ok(servicePendingStatus(child, [], `${kind}:darc:project`));
		}
		assert.ok(servicePendingStatus(service, [], `${kind}:darc:${service.id}`));
		assert.equal(servicePendingStatus(sibling, [], `${kind}:darc:${service.id}`), '');
		assert.equal(servicePendingStatus(service, [], `${kind}:elsewhere:project`), '');
	}
});

test('watch startup submits every merged file together so one project watch starts all children', async () => {
	const requests: Record<string, unknown>[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (_, init) => {
		requests.push(JSON.parse(String(init?.body)));
		return Promise.resolve(Response.json({ watching: true, watchUrl: '/watch/darc' }));
	};
	try {
		const watching = { ...project, watching: true };
		for (const path of composeStartupPaths(watching)) {
			await startProject(ui, path, true, undefined, true, { removeOrphans: false });
		}
		assert.equal(requests.length, 1);
		assert.equal(requests[0].path, composeActionPaths(project).join(','));
		assert.equal(requests[0].watch, true);
		assert.deepEqual(composeStartupPaths(watching, service), [service.composePath]);
		assert.deepEqual(composeStartupPaths(watching, undefined, false), composeActionPaths(project));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('build animation survives polling and clears on failure or success', () => {
	assert.equal(servicePendingStatus(service, [build]), 'building');
	assert.equal(servicePendingStatus({ ...service, serviceName: 'darc' }, [build]), '');
	assert.equal(
		servicePendingStatus(service, [{ ...build, projectId: 'other', projectName: 'other' }]),
		''
	);
	for (const status of ['failed', 'succeeded'] as const) {
		assert.equal(servicePendingStatus(service, [{ ...build, status }]), '');
	}
	assert.equal(
		servicePendingStatus(service, [{ ...build, serviceNames: ['darc', 'vscode'] }]),
		'building'
	);
});

test('build failures and recovery apply to all named services without hiding sibling failures', () => {
	const target = { id: 'darc', name: 'darc' };
	const failed = { ...build, status: 'failed' as const, serviceNames: ['darc', 'vscode'] };
	const recovered = {
		...build,
		id: '3',
		status: 'succeeded' as const,
		serviceNames: ['darc'],
		startedAt: '2026-10-22T00:01:00Z'
	};
	assert.equal(latestBuildFailure([failed, recovered], target), failed);
	assert.equal(latestBuildFailure([failed, recovered], target, { serviceName: 'darc' }), undefined);
	assert.equal(latestBuildFailure([failed, recovered], target, service), failed);
	assert.equal(
		latestBuildFailure([failed, recovered], target, { serviceName: 'unrelated' }),
		undefined
	);
	assert.equal(
		latestBuildFailure([failed, { ...recovered, serviceNames: ['darc', 'vscode'] }], target),
		undefined
	);
});

test('build titles show the container service, including failure history after a reload', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = () =>
		Promise.resolve(
			Response.json([
				{ id: '1', project: 'darc', services: ['darc'], success: true },
				{ id: '2', project: 'darc', services: ['vscode'], success: false }
			])
		);
	try {
		const builds = await loadBuilds(ui);
		assert.equal(buildTitle(builds[0]), 'darc / darc build #1');
		assert.equal(buildTitle(builds[1]), 'darc / vscode build #2');
		assert.equal(builds[1].serviceName, 'vscode');
		assert.equal(builds[1].status, 'failed');
		assert.equal(
			buildTitle({ ...build, serviceNames: ['darc', 'vscode'] }),
			'darc / darc, vscode build #2'
		);
		assert.equal(buildTitle({ ...build, serviceNames: undefined }), 'darc build #2');
		const [merged] = mergeBuilds(
			[{ ...build, targetName: 'darc', serviceNames: undefined }],
			[builds[1]]
		);
		assert.equal(buildTitle(merged), 'darc / vscode build #2');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('starting all merged files preserves sibling containers and retains overrides', async () => {
	const requests: Record<string, unknown>[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (_, init) => {
		requests.push(JSON.parse(String(init?.body)));
		return Promise.resolve(Response.json({ buildId: String(requests.length) }));
	};
	try {
		const paths = composeActionPaths(project);
		for (const path of paths) {
			await startProject(ui, path, false, undefined, true, { removeOrphans: paths.length === 1 });
		}
		assert.deepEqual(
			requests.map((request) => request.path),
			paths
		);
		assert.ok(requests.every((request) => request.removeOrphans === false));
		assert.ok(requests.every((request) => request.build === true && !request.services));
		await startProject(ui, service.composePath, false, ['vscode'], true, { removeOrphans: false });
		assert.deepEqual(requests[2].services, ['vscode']);
		assert.equal(requests[2].removeOrphans, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
