import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeMemoryWarning } from '../src/lib/central/resource-state.ts';
import type { RuntimeStatus } from '../src/lib/central/types.ts';

const incident = {
	id: 'oom-1',
	reason: 'oom',
	message: 'Increase VM memory or run fewer builds.',
	occurredAt: '2026-10-22T11:00:00Z',
	memoryLimitBytes: 4096
};
const recovered: RuntimeStatus = {
	phase: 'healthy',
	message: 'Ready',
	oomKillCount: 0,
	lastIncident: incident
};

test('OOM remains visible after recovery and a new VM boot resets its counter', () => {
	assert.equal(runtimeMemoryWarning(recovered)?.title, 'VM ran out of memory');
	assert.equal(runtimeMemoryWarning(recovered)?.id, incident.id);
});

test('dismissal hides only the acknowledged incident', () => {
	assert.equal(runtimeMemoryWarning(recovered, incident.id), null);
	assert.equal(
		runtimeMemoryWarning({ ...recovered, lastIncident: { ...incident, id: 'oom-2' } }, incident.id)
			?.id,
		'oom-2'
	);
});

test('memory pressure warns before an OOM without requiring build output', () => {
	const pressure = {
		phase: 'healthy',
		message: 'Ready',
		memoryTotalBytes: 100,
		memoryAvailableBytes: 10
	};
	assert.equal(runtimeMemoryWarning(pressure)?.title, 'VM memory is almost full');
	assert.equal(runtimeMemoryWarning({ ...pressure, memoryAvailableBytes: 11 }), null);
	assert.equal(
		runtimeMemoryWarning({ ...pressure, ...recovered }, incident.id)?.title,
		'VM memory is almost full'
	);
	assert.equal(runtimeMemoryWarning({ ...pressure, phase: 'stopped' }), null);
});

test('unavailable and malformed telemetry does not report false pressure', () => {
	assert.equal(runtimeMemoryWarning(null), null);
	assert.equal(runtimeMemoryWarning({ phase: 'healthy', message: 'Ready' }), null);
	for (const total of [0, -1, NaN, Infinity]) {
		assert.equal(
			runtimeMemoryWarning({
				phase: 'healthy',
				message: 'Ready',
				memoryTotalBytes: total,
				memoryAvailableBytes: 0
			}),
			null
		);
	}
});
