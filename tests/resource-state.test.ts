import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { memoryBuildFailures, resourcePressure } from '../src/lib/central/resource-state.ts';
import type { ComposeBuild } from '../src/lib/central/types.ts';

test('resource pressure changes at the warning and critical thresholds', () => {
	assert.equal(resourcePressure(undefined), 'normal');
	assert.equal(resourcePressure(79.99), 'normal');
	assert.equal(resourcePressure(80), 'warning');
	assert.equal(resourcePressure(94.99), 'warning');
	assert.equal(resourcePressure(95), 'critical');
	assert.equal(resourcePressure(120), 'critical');
});

const failed: ComposeBuild = {
	id: 'oom',
	projectId: 'openchamber',
	projectName: 'openchamber',
	serviceName: 'web',
	status: 'failed',
	startedAt: '2026-09-29T01:00:00Z',
	finishedAt: '2026-09-29T01:01:00Z',
	success: false,
	streamUrl: '/builds/oom/stream'
};
const message =
	'failed to solve: ResourceExhausted: process "/bin/sh -c bun run build:web" did not complete successfully: cannot allocate memory';
const output = [{ buildId: failed.id, message }];

test('a build allocation failure stays visible after usage recovers and during retry', () => {
	assert.equal(resourcePressure(40), 'normal');
	assert.deepEqual(memoryBuildFailures([failed], output), [{ build: failed, message }]);
	const retry = {
		...failed,
		id: 'retry',
		startedAt: '2026-09-29T02:00:00Z',
		status: 'running' as const
	};
	assert.equal(memoryBuildFailures([failed, retry], output)[0].build.id, failed.id);
	assert.deepEqual(memoryBuildFailures([failed, { ...retry, status: 'succeeded' }], output), []);
});

test('memory warnings clear only for the recovered target, including project-wide builds', () => {
	const recovered = {
		...failed,
		id: 'recovered',
		startedAt: '2026-09-29T02:00:00Z',
		status: 'succeeded' as const
	};
	assert.equal(
		memoryBuildFailures([failed, { ...recovered, serviceName: 'db' }], output).length,
		1
	);
	assert.equal(
		memoryBuildFailures(
			[failed, { ...recovered, projectId: 'other', projectName: 'other' }],
			output
		).length,
		1
	);
	assert.deepEqual(
		memoryBuildFailures([failed, { ...recovered, serviceName: undefined }], output),
		[]
	);
});

test('disk exhaustion, compiler errors and successful builds do not report memory failures', () => {
	for (const diagnostic of ['ResourceExhausted: no space left on device', 'failed to compile']) {
		assert.deepEqual(
			memoryBuildFailures([failed], [{ buildId: failed.id, message: diagnostic }]),
			[]
		);
	}
	assert.deepEqual(memoryBuildFailures([{ ...failed, status: 'succeeded' }], output), []);
	for (const diagnostic of ['FATAL ERROR: JavaScript heap out of memory', 'ENOMEM', 'OOM-killed']) {
		assert.equal(
			memoryBuildFailures([failed], [{ buildId: failed.id, message: diagnostic }]).length,
			1
		);
	}
});
