import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	areProjectServicesStoppedWithoutError,
	hasFailedServicesOutsideTransition,
	isExpectedServiceStop,
	servicePendingStatus
} from '../src/lib/central/service-state.ts';

const transitioning = { id: 'web', state: 'restarting', stateText: 'Restarting (1)' } as const;
const failed = { id: 'worker', state: 'exited', stateText: 'Exited (1) 2 minutes ago' } as const;

test('any finally failed container keeps the parent red regardless of other container states', () => {
	assert.equal(hasFailedServicesOutsideTransition([transitioning, failed], ['web']), true);
	assert.equal(
		hasFailedServicesOutsideTransition(
			[transitioning, failed, { ...failed, id: 'scheduler', stateText: 'Exited (137)' }],
			['web']
		),
		true
	);
	for (const state of [
		'running',
		'paused',
		'created',
		'uncreated',
		'unknown',
		'restarting'
	] as const) {
		assert.equal(
			hasFailedServicesOutsideTransition(
				[transitioning, failed, { id: 'other', state, stateText: state }],
				['web']
			),
			true,
			state
		);
	}
	assert.equal(
		hasFailedServicesOutsideTransition(
			[transitioning, failed, { ...transitioning, id: 'other' }],
			['web', 'other']
		),
		true
	);
	assert.equal(hasFailedServicesOutsideTransition([failed], []), true);
	assert.equal(hasFailedServicesOutsideTransition([transitioning, failed], ['missing']), true);
	for (const stateText of ['Exited (0) 2 minutes ago', 'Stopped']) {
		assert.equal(
			hasFailedServicesOutsideTransition([transitioning, { ...failed, stateText }], ['web']),
			false
		);
	}
});

test('previous failures stop contributing while those containers are transitioning', () => {
	for (const state of ['running', 'exited', 'uncreated'] as const) {
		assert.equal(
			hasFailedServicesOutsideTransition([{ ...transitioning, state }, failed], ['web']),
			true
		);
	}
	assert.equal(
		hasFailedServicesOutsideTransition([transitioning, failed], ['web', 'worker']),
		false
	);
	assert.equal(
		hasFailedServicesOutsideTransition([failed, { ...failed, id: 'other' }], ['worker', 'other']),
		false
	);
	assert.equal(hasFailedServicesOutsideTransition([failed], ['worker']), false);
	assert.equal(hasFailedServicesOutsideTransition([transitioning], []), false);
	assert.equal(hasFailedServicesOutsideTransition([transitioning], ['web']), false);
	assert.equal(hasFailedServicesOutsideTransition([], ['web']), false);
});

test('retrying a previously failed container clears its contribution until the retry ends', () => {
	const worker = { ...failed, projectId: 'demo', projectName: 'demo', serviceName: 'worker' };
	const sibling = { ...worker, id: 'scheduler', serviceName: 'scheduler' };
	const hasFailure = (services: (typeof worker | typeof sibling)[], busyAction: string | null) =>
		hasFailedServicesOutsideTransition(
			services,
			services
				.filter((service) => servicePendingStatus(service, [], busyAction))
				.map((service) => service.id)
		);

	for (const kind of ['start', 'up-no-build', 'restart']) {
		assert.equal(hasFailure([worker], `${kind}:demo:worker`), false);
		assert.equal(hasFailure([worker, sibling], `${kind}:demo:project`), false);
		assert.equal(hasFailure([worker, sibling], `${kind}:demo:worker`), true);
	}
	assert.equal(hasFailure([worker], null), true);
});

test('successful and explicitly stopped containers use the neutral stopped state', () => {
	assert.equal(
		isExpectedServiceStop({ state: 'exited', stateText: 'Exited (0) 2 minutes ago' }),
		true
	);
	assert.equal(isExpectedServiceStop({ state: 'exited', stateText: 'Stopped' }), true);
	assert.equal(
		isExpectedServiceStop({ state: 'exited', stateText: 'Stopped 5 seconds ago' }),
		true
	);
});

test('failed exits remain distinct from neutral stops', () => {
	assert.equal(
		isExpectedServiceStop({ state: 'exited', stateText: 'Exited (1) 2 minutes ago' }),
		false
	);
	assert.equal(
		isExpectedServiceStop({ state: 'exited', stateText: 'Exited (137) 2 minutes ago' }),
		false
	);
	assert.equal(isExpectedServiceStop({ state: 'running', stateText: 'Up 10 seconds' }), false);
});

test('a project is neutral only when every loaded service is stopped without an error', () => {
	assert.equal(
		areProjectServicesStoppedWithoutError([
			{ state: 'exited', stateText: 'Exited (0) 2 minutes ago' },
			{ state: 'exited', stateText: 'Stopped' },
			{ state: 'uncreated', stateText: 'Uncreated' }
		]),
		true
	);
	assert.equal(
		areProjectServicesStoppedWithoutError([
			{ state: 'exited', stateText: 'Exited (0) 2 minutes ago' },
			{ state: 'exited', stateText: 'Exited (1) 2 minutes ago' }
		]),
		false
	);
	assert.equal(
		areProjectServicesStoppedWithoutError([
			{ state: 'exited', stateText: 'Exited (0) 2 minutes ago' },
			{ state: 'running', stateText: 'Up 2 minutes' }
		]),
		false
	);
	assert.equal(areProjectServicesStoppedWithoutError([]), false);
});
