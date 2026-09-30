import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { vmHostMetrics } from '../src/lib/central/vm-resource-metrics.ts';

const formatBytes = (value: number | undefined) => (value === undefined ? '—' : `${value} B`);

test('old runtime responses and unavailable samples do not invent zero usage', () => {
	assert.deepEqual(vmHostMetrics(undefined, formatBytes), []);
	assert.deepEqual(vmHostMetrics({}, formatBytes), []);
	assert.deepEqual(
		vmHostMetrics({ memoryLimitBytes: 8192, diskLogicalBytes: 30000 }, formatBytes),
		[]
	);
});

test('zero balloon inflation remains visible alongside resident RAM and sparse allocation', () => {
	const metrics = vmHostMetrics(
		{
			memoryResidentBytes: 1024,
			memoryLimitBytes: 8192,
			balloonTargetBytes: 256,
			balloonInflatedBytes: 0,
			diskAllocatedBytes: 100,
			diskLogicalBytes: 30000
		},
		formatBytes
	);
	assert.deepEqual(
		metrics.map(({ label, value }) => ({ label, value })),
		[
			{ label: 'HOST RAM', value: '1024 B' },
			{ label: 'BALLOON', value: '0 B' },
			{ label: 'IMAGE', value: '100 B' }
		]
	);
	assert.match(metrics[0].tooltip, /8192 B configured guest limit/);
	assert.match(metrics[1].tooltip, /256 B target/);
	assert.match(metrics[2].tooltip, /100 B allocated blocks \/ 30000 B logical file size/);
	// Neither reclaim nor sparse allocation is a guest pressure percentage.
	assert.ok(metrics.every((metric) => !('percent' in metric)));
});

test('partial samples show the available gauge without substituting guest values', () => {
	const metrics = vmHostMetrics({ diskAllocatedBytes: 0 }, formatBytes);
	assert.equal(metrics.length, 1);
	assert.equal(metrics[0].label, 'IMAGE');
	assert.equal(metrics[0].value, '0 B');
	assert.match(metrics[0].tooltip, /— logical file size/);
});
