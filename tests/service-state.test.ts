import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	areProjectServicesStoppedWithoutError,
	isExpectedServiceStop
} from '../src/lib/central/service-state.ts';

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
