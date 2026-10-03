import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { vmDiskMetrics, vmHostMetrics } from '../src/lib/central/vm-resource-metrics.ts';

const formatBytes = (value: number | undefined) => (value === undefined ? '—' : `${value} B`);

test('VM disk free space stays unavailable when only sparse image allocation is known', () => {
	for (const resources of [undefined, {}, { diskAllocatedBytes: 100, diskLogicalBytes: 30000 }]) {
		const metric = vmDiskMetrics(resources, formatBytes)[0];
		assert.equal(metric.label, 'DISK FREE');
		assert.equal(metric.value, '—');
		assert.equal(metric.percent, undefined);
		assert.equal(metric.pressure, 'normal');
		assert.match(metric.tooltip, /free space unavailable/);
	}
});

test('guest filesystem counters show available bytes and warn before Docker runs out of space', () => {
	const metric = vmDiskMetrics(
		{
			diskTotalBytes: 21118275584,
			diskAvailableBytes: 163483648,
			diskTotalInodes: 1310720,
			diskFreeInodes: 631409,
			diskAllocatedBytes: 21150126080,
			diskLogicalBytes: 32212254720
		},
		formatBytes
	)[0];
	assert.equal(metric.value, '163483648 B');
	assert.equal(metric.pressure, 'critical');
	assert.ok(metric.percent! > 99);
	assert.match(metric.tooltip, /163483648 B \/ 21118275584 B/);
});

test('zero guest space is visible and critical rather than unavailable', () => {
	const metric = vmDiskMetrics({ diskTotalBytes: 1000, diskAvailableBytes: 0 }, formatBytes)[0];
	assert.equal(metric.value, '0 B');
	assert.equal(metric.percent, 100);
	assert.equal(metric.pressure, 'critical');
	assert.match(metric.tooltip, /Disk full/);
	assert.equal(vmDiskMetrics({ diskAvailableBytes: 0 }, formatBytes)[0].pressure, 'critical');
});

test('inode exhaustion is critical even when plenty of bytes remain', () => {
	const metric = vmDiskMetrics(
		{ diskTotalBytes: 1000, diskAvailableBytes: 800, diskTotalInodes: 100, diskFreeInodes: 0 },
		formatBytes
	)[0];
	assert.equal(metric.value, '800 B · 0 inodes');
	assert.equal(metric.percent, 20);
	assert.equal(metric.pressure, 'critical');
	assert.match(metric.tooltip, /No free inodes/);
});

test('healthy and low guest space use the existing pressure thresholds', () => {
	for (const [available, pressure] of [
		[500, 'normal'],
		[100, 'warning'],
		[50, 'critical']
	] as const) {
		const metric = vmDiskMetrics(
			{ diskTotalBytes: 1000, diskAvailableBytes: available },
			formatBytes
		)[0];
		assert.equal(metric.pressure, pressure);
	}
	const inodeWarning = vmDiskMetrics(
		{ diskTotalBytes: 1000, diskAvailableBytes: 800, diskTotalInodes: 100, diskFreeInodes: 10 },
		formatBytes
	)[0];
	assert.equal(inodeWarning.pressure, 'warning');
});

test('old runtime responses and unavailable samples do not invent zero usage', () => {
	for (const resources of [undefined, {}, { memoryLimitBytes: 8192, diskLogicalBytes: 30000 }]) {
		assert.deepEqual(vmHostMetrics(resources, formatBytes), [
			{
				label: 'IMAGE',
				value: '—',
				tooltip: 'VM disk images unavailable'
			}
		]);
	}
});

test('host gauges show resident RAM with its guest limit and sparse allocation', () => {
	const metrics = vmHostMetrics(
		{
			memoryResidentBytes: 1024,
			memoryLimitBytes: 8192,
			diskAllocatedBytes: 100,
			diskLogicalBytes: 30000
		},
		formatBytes
	);
	assert.deepEqual(
		metrics.map(({ label, value }) => ({ label, value })),
		[
			{ label: 'HOST RAM', value: '1024 B' },
			{ label: 'IMAGE', value: '100 B' }
		]
	);
	assert.match(metrics[0].tooltip, /8192 B guest limit/);
	assert.match(metrics[1].tooltip, /100 B allocated \/ 30000 B logical/);
	// Neither resident RAM nor sparse allocation is a guest pressure percentage.
	assert.ok(metrics.every((metric) => !('percent' in metric)));
});

test('partial samples show the available gauge without substituting guest values', () => {
	const metrics = vmHostMetrics({ diskAllocatedBytes: 0 }, formatBytes);
	assert.equal(metrics.length, 1);
	assert.equal(metrics[0].label, 'IMAGE');
	assert.equal(metrics[0].value, '0 B');
	assert.match(metrics[0].tooltip, /— logical/);
});
