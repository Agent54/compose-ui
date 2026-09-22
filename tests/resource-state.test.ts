import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { resourcePressure } from '../src/lib/central/resource-state.ts';

test('resource pressure changes at the warning and critical thresholds', () => {
	assert.equal(resourcePressure(undefined), 'normal');
	assert.equal(resourcePressure(79.99), 'normal');
	assert.equal(resourcePressure(80), 'warning');
	assert.equal(resourcePressure(94.99), 'warning');
	assert.equal(resourcePressure(95), 'critical');
	assert.equal(resourcePressure(120), 'critical');
});
