import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { isExpectedServiceStop } from '../src/lib/central/service-state.ts';

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
