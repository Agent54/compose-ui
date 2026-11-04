import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	projectPendingStatus,
	projectStateRank,
	servicePendingStatus,
	serviceStateRank
} from '../src/lib/central/service-state.ts';
import type { ServiceAction } from '../src/lib/central/action-state.ts';
import type { ComposeBuild } from '../src/lib/central/types.ts';

const project = { id: 'demo', name: 'demo', state: 'running', statusLabel: 'running(2)' } as const;
const web = {
	id: 'demo:web-container',
	projectId: project.id,
	projectName: project.name,
	serviceName: 'web',
	state: 'running'
} as const;
const worker = { ...web, id: 'demo:worker-container', serviceName: 'worker' };
const unrelated = { ...project, id: 'other', name: 'other' };
const build: ComposeBuild = {
	id: 'build-from-server',
	projectId: project.id,
	projectName: project.name,
	serviceNames: ['web'],
	status: 'running',
	startedAt: '2026-10-29T00:00:00Z',
	finishedAt: null,
	success: null,
	streamUrl: '/builds/build-from-server/stream'
};

test('every pending child makes its parent pending, without affecting siblings or other projects', () => {
	const sources: Array<{ actions?: ServiceAction[]; builds?: ComposeBuild[] }> = [];
	for (const kind of [
		'start',
		'up-no-build',
		'restart',
		'stop',
		'remove',
		'pause',
		'unpause',
		'watching'
	]) {
		sources.push({ actions: [{ kind, projectId: project.id, serviceId: web.id }] });
	}
	sources.push({ builds: [build] });
	sources.push({
		builds: [{ ...build, projectId: 'server-alias', serviceNames: undefined, serviceName: 'web' }]
	});

	for (const source of sources) {
		const { actions = [], builds = [] } = source;
		const child = servicePendingStatus(web, builds, actions);
		assert.ok(child, JSON.stringify(source));
		// The same status drives both refresh icons; no build-target side channel is needed.
		assert.equal(projectPendingStatus(project, [web, worker], builds, actions), child);
		assert.equal(servicePendingStatus(worker, builds, actions), '');
		assert.equal(projectPendingStatus(unrelated, [web, worker], builds, actions), '');
		// Collapsing/unloading the children cannot hide known project work.
		assert.equal(projectPendingStatus(project, [], builds, actions), child);
	}
});

test('project-scoped work applies the same pending state to every container', () => {
	const sources = [
		{ actions: [{ kind: 'start', projectId: project.id }], builds: [] },
		{ actions: [], builds: [{ ...build, serviceNames: [] }] }
	];
	for (const { actions, builds } of sources) {
		const parent = projectPendingStatus(project, [web, worker], builds, actions);
		assert.ok(parent);
		for (const child of [web, worker]) {
			assert.equal(servicePendingStatus(child, builds, actions), parent);
		}
	}
});

test('submitted requests and polled builds remain pending until success or failure', () => {
	const snapshots = [
		{
			actions: [{ kind: 'start', projectId: project.id, serviceId: web.id }],
			builds: [],
			expected: 'starting'
		},
		{ actions: [], builds: [build], expected: 'building' },
		{ actions: [], builds: [{ ...build, status: 'succeeded' as const }], expected: '' },
		{ actions: [], builds: [{ ...build, status: 'failed' as const }], expected: '' }
	];
	for (const { actions, builds, expected } of snapshots) {
		assert.equal(servicePendingStatus(web, builds, actions), expected);
		assert.equal(projectPendingStatus(project, [web, worker], builds, actions), expected);
	}
});

test('backend restarts propagate to the parent and clear when the last child settles', () => {
	const restarting = { ...worker, state: 'restarting' as const };
	assert.equal(servicePendingStatus(restarting, []), 'restarting');
	assert.equal(projectPendingStatus(project, [web, restarting], []), 'restarting');
	assert.equal(projectPendingStatus(project, [web, worker], []), '');
	assert.equal(
		projectPendingStatus({ ...project, statusLabel: 'restarting(1)' }, [], []),
		'restarting'
	);
	assert.equal(projectPendingStatus({ ...project, statusLabel: 'restarting(0)' }, [], []), '');
});

test('a pending child still propagates when discovery and build project names temporarily differ', () => {
	const child = { ...web, projectName: 'discovered-alias' };
	const polledBuild = { ...build, projectId: 'server-alias', projectName: child.projectName };
	assert.equal(servicePendingStatus(child, [polledBuild]), 'building');
	assert.equal(projectPendingStatus(project, [child, worker], [polledBuild]), 'building');
	assert.equal(projectPendingStatus(unrelated, [child, worker], [polledBuild]), '');
});

test('starting and building sort before inactive rows throughout request and build handoff', () => {
	const uncreatedProject = { ...project, state: 'uncreated' as const, statusLabel: 'uncreated(2)' };
	const uncreatedWeb = { ...web, state: 'uncreated' as const };
	const uncreatedWorker = { ...worker, state: 'uncreated' as const };
	const children = [uncreatedWeb, uncreatedWorker];
	const snapshots: Array<{
		actions: ServiceAction[];
		builds: ComposeBuild[];
		expected: string;
	}> = [
		{
			actions: [{ kind: 'start', projectId: project.id, serviceId: web.id }],
			builds: [],
			expected: 'starting'
		},
		{
			actions: [{ kind: 'start', projectId: project.id, serviceId: web.id }],
			builds: [build],
			expected: 'starting'
		},
		{ actions: [], builds: [build], expected: 'building' }
	];

	for (const { actions, builds, expected } of snapshots) {
		const childStatus = servicePendingStatus(uncreatedWeb, builds, actions);
		assert.equal(childStatus, expected);
		assert.equal(servicePendingStatus(uncreatedWorker, builds, actions), '');
		const childRank = serviceStateRank(uncreatedWeb.state, childStatus);
		assert.equal(childRank, serviceStateRank('running'));
		for (const state of ['paused', 'exited', 'created', 'unknown', 'uncreated'] as const) {
			assert.ok(childRank < serviceStateRank(state), `${expected} before ${state}`);
		}
		for (const services of [children, []]) {
			const parentStatus = projectPendingStatus(uncreatedProject, services, builds, actions);
			assert.equal(parentStatus, expected);
			const parentRank = projectStateRank(uncreatedProject.state, parentStatus);
			assert.equal(parentRank, projectStateRank('running'));
			for (const state of [
				'paused',
				'mixed',
				'exited',
				'stopped',
				'created',
				'unknown',
				'uncreated'
			] as const) {
				assert.ok(parentRank < projectStateRank(state), `${expected} parent before ${state}`);
			}
		}
	}

	for (const status of ['succeeded', 'failed'] as const) {
		const builds = [{ ...build, status }];
		assert.equal(
			serviceStateRank(uncreatedWeb.state, servicePendingStatus(uncreatedWeb, builds)),
			serviceStateRank('uncreated')
		);
		assert.equal(
			projectStateRank(
				uncreatedProject.state,
				projectPendingStatus(uncreatedProject, children, builds)
			),
			projectStateRank('uncreated')
		);
	}
});

test('all displayed pending operations receive the same active sorting priority', () => {
	for (const kind of [
		'start',
		'up-no-build',
		'unpause',
		'restart',
		'stop',
		'remove',
		'pause',
		'watching'
	]) {
		const actions = [{ kind, projectId: project.id }];
		const parentStatus = projectPendingStatus(project, [], [], actions);
		const childStatus = servicePendingStatus(web, [], actions);
		assert.ok(parentStatus, kind);
		assert.equal(parentStatus, childStatus);
		assert.equal(projectStateRank('uncreated', parentStatus), projectStateRank('running'), kind);
		assert.equal(serviceStateRank('uncreated', childStatus), serviceStateRank('running'), kind);
	}
});
