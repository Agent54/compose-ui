import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	descriptorIntervalMs,
	descriptorPressure,
	fileDescriptorUrl,
	pollFileDescriptors,
	serviceDescriptorMetric,
	serviceWatcherMetric,
	vmDescriptorMetric,
	type FileDescriptorSnapshot
} from '../src/lib/central/file-descriptors.ts';

const snapshot: FileDescriptorSnapshot = {
	sampledAt: '2026-10-25T00:00:00Z',
	bootId: 'boot-1',
	containerId: 'a'.repeat(64),
	vm: { used: 900, limit: 1000 },
	partial: false,
	processes: [
		{
			pid: 10,
			name: 'web',
			used: 900,
			softLimit: 1000,
			hardLimit: 2000,
			available: 100,
			truncated: false
		},
		{
			pid: 11,
			name: 'worker',
			used: 95,
			softLimit: 100,
			hardLimit: 100,
			available: 5,
			truncated: false
		}
	]
};

test('descriptor markers use remaining headroom: orange at 10%, red at 5%', () => {
	assert.equal(descriptorIntervalMs, 10000);
	for (const [available, expected] of [
		[11, 'normal'],
		[10, 'warning'],
		[6, 'warning'],
		[5, 'critical'],
		[0, 'critical']
	] as const) {
		assert.equal(descriptorPressure(available, 100), expected);
	}
	assert.equal(descriptorPressure(0, 0), 'critical');
	for (const unavailable of [undefined, NaN, Infinity, -1]) {
		assert.equal(descriptorPressure(unavailable, 100), 'normal');
		assert.equal(descriptorPressure(1, unavailable), 'normal');
	}
	assert.equal(descriptorPressure(101, 100), 'normal');
	assert.equal(vmDescriptorMetric(snapshot).pressure, 'warning');
});

test('selected service shows the process closest to its own limit, not an aggregate budget', () => {
	const metric = serviceDescriptorMetric(snapshot, snapshot.containerId!);
	assert.equal(metric.pressure, 'critical');
	assert.equal(metric.value, '5');
	assert.match(metric.tooltip, /worker \(PID 11\)/);
	assert.match(metric.tooltip, /Open 95/);
	assert.equal(serviceDescriptorMetric(snapshot, 'b'.repeat(64)).value, '—');
});

test('watcher failures remain visible with healthy FDs and are scoped to the current container run', () => {
	const healthyFDs = { ...snapshot, processes: [] };
	assert.equal(serviceWatcherMetric(healthyFDs, snapshot.containerId!), null);
	const failed = {
		...healthyFDs,
		inotifyWatchLimit: 64379,
		watcherError: '2026-10-25T10:21:50Z [File Watcher] Inotify limit reached (ENOSPC)'
	};
	const metric = serviceWatcherMetric(failed, snapshot.containerId!);
	assert.equal(metric?.pressure, 'critical');
	assert.equal(metric?.value, 'ENOSPC');
	assert.match(metric!.tooltip, /64,379/);
	assert.match(metric!.tooltip, /Recovery has not been confirmed/);
	assert.equal(serviceWatcherMetric(failed, 'b'.repeat(64)), null);
	assert.equal(serviceWatcherMetric(null, snapshot.containerId!), null);
	assert.equal(serviceWatcherMetric({ ...failed, watcherError: undefined }, snapshot.containerId!), null);
});

test('unavailable, unlimited and capped scans never imply zero free descriptors', () => {
	assert.equal(vmDescriptorMetric(null).value, '—');
	const partial = {
		...snapshot,
		partial: true,
		processes: [
			{
				pid: 1,
				name: 'capped',
				used: 131072,
				softLimit: 1048576,
				hardLimit: 1048576,
				truncated: true
			}
		]
	};
	const metric = serviceDescriptorMetric(partial, snapshot.containerId!);
	assert.equal(metric.value, '—*');
	assert.equal(metric.pressure, 'normal');
	assert.match(metric.tooltip, /incomplete/);
	assert.equal(
		serviceDescriptorMetric(
			{
				...snapshot,
				processes: [
					{
						pid: 1,
						name: 'unlimited',
						used: 3,
						truncated: false
					}
				]
			},
			snapshot.containerId!
		).value,
		'—*'
	);
});

test('URLs request only the selected container; no selection requests kernel counters alone', () => {
	assert.equal(fileDescriptorUrl('', 'v1.24'), '/v1.24/file-descriptors');
	assert.equal(
		fileDescriptorUrl('https://compose-ui.localhost/', '1.24', snapshot.containerId),
		'https://compose-ui.localhost/v1.24/file-descriptors?container=' + snapshot.containerId
	);
});

test('disposing a service monitor aborts the request and ignores its late result', async () => {
	let finish!: (response: Response) => void;
	let signal: AbortSignal | undefined;
	let updates = 0;
	const stop = pollFileDescriptors('/file-descriptors', () => updates++, {
		visible: () => true,
		fetch: ((_url, options) => {
			signal = (options as { signal?: AbortSignal } | undefined)?.signal;
			return new Promise<Response>((resolve) => {
				finish = resolve;
			});
		}) as typeof fetch
	});
	stop();
	assert.equal(signal?.aborted, true);
	finish(Response.json(snapshot));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(updates, 0);
});

test('hidden pages do not request descriptor scans', () => {
	let requests = 0;
	const stop = pollFileDescriptors('/file-descriptors', () => {}, {
		visible: () => false,
		fetch: (() => {
			requests++;
			return Promise.resolve(Response.json(snapshot));
		}) as typeof fetch
	});
	stop();
	assert.equal(requests, 0);
});
