import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attributeDiskObjects, groupDiskObjects } from '../src/lib/central/disk-objects.ts';
import type { DiskItem } from '../src/lib/central/disk-usage.ts';

const item = (name: string, values: Partial<DiskItem> = {}): DiskItem => ({
	kind: 'images',
	name,
	candidate: false,
	detail: '',
	...values
});

test('service groups distinguish projects and shared objects appear exactly once', () => {
	const rows = [
		item('image', { group: 'service', services: [{ project: 'shop', name: 'web' }], bytes: 100 }),
		item('container', {
			kind: 'containers',
			group: 'service',
			services: [{ project: 'shop', name: 'web' }],
			bytes: 10
		}),
		item('other web', {
			group: 'service',
			services: [{ project: 'admin', name: 'web' }],
			bytes: 90
		}),
		item('base', {
			group: 'shared',
			services: [
				{ project: 'shop', name: 'web' },
				{ project: 'admin', name: 'web' }
			],
			bytes: 200
		}),
		item('orphan', { group: 'dangling', bytes: 1 })
	];
	const groups = groupDiskObjects(rows);
	assert.deepEqual(
		groups.map((group) => group.label),
		['Shared', 'shop / web', 'admin / web', 'Dangling']
	);
	assert.equal(groups.flatMap((group) => group.items).length, rows.length);
	assert.equal(groups[1].items.length, 2);
	assert.deepEqual(
		rows.map((row) => row.name),
		['image', 'container', 'other web', 'base', 'orphan']
	);
});

test('size and reclaimable sorting rank groups and rows in both directions with unknowns last', () => {
	const rows = [
		item('large', { group: 'dangling', bytes: 900, reclaimableBytes: 1 }),
		item('small', { group: 'dangling', bytes: 10, reclaimableBytes: 50 }),
		item('unknown', { group: 'dangling' }),
		item('cache', { kind: 'build-cache', bytes: 100, reclaimableBytes: 100 }),
		item('unmeasured')
	];
	assert.deepEqual(
		groupDiskObjects(rows, 'size', 'desc').map((group) => group.label),
		['Dangling', 'Build cache', 'Other']
	);
	assert.deepEqual(
		groupDiskObjects(rows, 'size', 'asc')[1].items.map((row) => row.name),
		['small', 'large', 'unknown']
	);
	const reclaimable = groupDiskObjects(rows, 'reclaimable', 'desc');
	assert.deepEqual(
		reclaimable.map((group) => group.label),
		['Build cache', 'Dangling', 'Other']
	);
	assert.deepEqual(
		reclaimable[1].items.map((row) => row.name),
		['small', 'large', 'unknown']
	);
	assert.deepEqual(
		groupDiskObjects(rows, 'reclaimable', 'asc')[0].items.map((row) => row.name),
		['large', 'small', 'unknown']
	);
});

test('last-used sorting uses supplied timestamps, keeps unknowns last and brings the oldest or newest object groups first', () => {
	const rows = [
		item('new', { kind: 'build-cache', lastUsedAt: '2026-10-04T00:00:00Z' }),
		item('old', { kind: 'build-cache', lastUsedAt: '2026-10-01T00:00:00Z' }),
		item('invalid', { kind: 'build-cache', lastUsedAt: 'invalid' }),
		item('shared', { group: 'shared', lastUsedAt: '2026-10-03T00:00:00Z' }),
		item('image')
	];
	const newest = groupDiskObjects(rows, 'last-used', 'desc');
	assert.deepEqual(
		newest.map((group) => group.label),
		['Build cache', 'Shared', 'Other']
	);
	assert.deepEqual(
		newest[0].items.map((row) => row.name),
		['new', 'old', 'invalid']
	);
	const oldest = groupDiskObjects(rows, 'last-used', 'asc');
	assert.deepEqual(
		oldest.map((group) => group.label),
		['Build cache', 'Shared', 'Other']
	);
	assert.deepEqual(
		oldest[0].items.map((row) => row.name),
		['old', 'new', 'invalid']
	);
});

test('older reports remain usable without inventing service ownership or dangling status', () => {
	const groups = groupDiskObjects([
		item('legacy unused', { candidate: true }),
		item('cache', { kind: 'build-cache' })
	]);
	assert.deepEqual(
		groups.map((group) => group.label),
		['Build cache', 'Other']
	);
});

test('service references take precedence over category hints and cache layer sharing stays in cache', () => {
	const owner = { project: 'shop', name: 'web' };
	const groups = groupDiskObjects(
		attributeDiskObjects([
			item('single owner', { group: 'shared', services: [owner, owner] }),
			item('owned cache', { kind: 'build-cache', group: 'build-cache', services: [owner] }),
			item('image layer cache', { kind: 'build-cache', group: 'shared', services: [] }),
			item('multiple owners', {
				group: 'other',
				services: [owner, { project: 'admin', name: 'web' }]
			})
		])
	);
	assert.equal(groups.find((group) => group.label === 'shop / web')?.items.length, 2);
	assert.deepEqual(
		groups.find((group) => group.label === 'Build cache')?.items.map((row) => row.name),
		['image layer cache']
	);
	assert.deepEqual(
		groups.find((group) => group.label === 'Shared')?.items.map((row) => row.name),
		['multiple owners']
	);
});

test('cache attribution uses unique bounded service names and preserves ambiguous or reported ownership', () => {
	const owner = (project: string, name: string) =>
		item(`${project}-${name}`, {
			group: 'service',
			services: [{ project, name }]
		});
	const report = [
		owner('openchamber', 'openchamber'),
		owner('homepage', 'homepage'),
		owner('shop', 'web'),
		owner('admin', 'web'),
		owner('one', 'editor'),
		owner('two', 'editor'),
		item('RUN mkdir /home/openchamber', { kind: 'build-cache', group: 'shared' }),
		item('cached mount with id "/homepage-pnpm"', { kind: 'build-cache' }),
		item('RUN mkdir /home/openchamber-old', { kind: 'build-cache' }),
		item('COPY openchambered .', { kind: 'build-cache' }),
		item('COPY web .', { kind: 'build-cache' }),
		item('COPY editor .', { kind: 'build-cache' }),
		item('COPY openchamber homepage .', { kind: 'build-cache' }),
		item('shop/web COPY . .', { kind: 'build-cache' }),
		item('RUN mkdir /home/openchamber', {
			kind: 'build-cache',
			services: [{ project: 'shop', name: 'web' }]
		})
	];
	const attributed = attributeDiskObjects(report);
	assert.deepEqual(attributed[6].services, [{ project: 'openchamber', name: 'openchamber' }]);
	assert.equal(attributed[6].serviceInferred, true);
	assert.deepEqual(attributed[7].services, [{ project: 'homepage', name: 'homepage' }]);
	assert.equal(attributed[8].serviceInferred, true);
	assert(attributed.slice(9, 13).every((row) => !row.services?.length));
	assert.deepEqual(attributed[13].services, [{ project: 'shop', name: 'web' }]);
	assert.deepEqual(attributed[14].services, [{ project: 'shop', name: 'web' }]);
	assert.equal(attributed[14].serviceInferred, undefined);
	assert.equal(report[6].services, undefined);
	// Ownership is already resolved when selecting only cache rows.
	assert(
		groupDiskObjects(attributed.filter((row) => row.kind === 'build-cache')).some(
			(group) => group.label === 'homepage / homepage'
		)
	);
});

test('qualified project and service identifiers resolve siblings without guessing from project names', () => {
	const attributed = attributeDiskObjects([
		item('web image', { services: [{ project: 'homepage', name: 'web' }] }),
		item('worker image', { services: [{ project: 'homepage', name: 'worker' }] }),
		item('homepage/web COPY . .', { kind: 'build-cache' }),
		item('homepage-worker COPY . .', { kind: 'build-cache' }),
		item('cache mount with id homepage-pnpm', { kind: 'build-cache' })
	]);
	assert.deepEqual(attributed[2].services, [{ project: 'homepage', name: 'web' }]);
	assert.deepEqual(attributed[3].services, [{ project: 'homepage', name: 'worker' }]);
	assert.equal(attributed[4].services, undefined);
});

test('section totals distinguish zero, unknown and partially measured storage', () => {
	const groups = groupDiskObjects([
		item('measured', { group: 'shared', bytes: 100, reclaimableBytes: 0 }),
		item('unmeasured', { group: 'shared' }),
		item('zero', { group: 'dangling', bytes: 0, reclaimableBytes: 0 }),
		item('unknown')
	]);
	const shared = groups.find((group) => group.label === 'Shared')!;
	assert.equal(shared.bytes, 100);
	assert.equal(shared.reclaimableBytes, 0);
	assert.equal(shared.partialBytes, true);
	assert.equal(shared.partialReclaimableBytes, true);
	const zero = groups.find((group) => group.label === 'Dangling')!;
	assert.equal(zero.bytes, 0);
	assert.equal(zero.partialBytes, false);
	const unknown = groups.find((group) => group.label === 'Other')!;
	assert.equal(unknown.bytes, undefined);
	assert.equal(unknown.partialBytes, false);
});

test('repeated cache commands combine totals and status without dropping distinct entries', () => {
	const rows = [
		item('[runtime 2/4] COPY . /app', {
			id: 'build-cache:a',
			kind: 'build-cache',
			group: 'shared',
			bytes: 10,
			reclaimableBytes: 0,
			candidate: true,
			lastUsedAt: '2026-10-01T00:00:00Z'
		}),
		item('[runtime 3/6] COPY . /app', {
			id: 'build-cache:b',
			kind: 'build-cache',
			bytes: 20,
			reclaimableBytes: 20,
			lastUsedAt: '2026-10-04T00:00:00Z'
		}),
		item('RUN install', {
			id: 'build-cache:c',
			kind: 'build-cache',
			bytes: 25,
			reclaimableBytes: 25
		}),
		item('same image', { id: 'images:a', bytes: 1 }),
		item('same image', { id: 'images:b', bytes: 2 })
	];
	const groups = groupDiskObjects(rows);
	const cache = groups.find((group) => group.label === 'Build cache')!;
	assert.equal(cache.items.length, 3);
	assert.equal(cache.rows.length, 2);
	const combined = cache.rows[0];
	assert.equal(combined.name, 'COPY . /app');
	assert.equal(combined.bytes, 30);
	assert.equal(combined.reclaimableBytes, 20);
	assert.equal(combined.candidateCount, 1);
	assert.equal(combined.lastUsedAt, '2026-10-04T00:00:00Z');
	assert.deepEqual(combined.items.map((row) => row.id).sort(), ['build-cache:a', 'build-cache:b']);
	assert.equal(groups.find((group) => group.label === 'Other')?.rows.length, 2);
	assert.equal(
		groups.flatMap((group) => group.rows.flatMap((row) => row.items)).length,
		rows.length
	);
	assert.deepEqual(groupDiskObjects([...rows].reverse()), groups);
	assert.equal(groupDiskObjects(rows, 'reclaimable')[0].rows[0].name, 'RUN install');
});

test('combined cache rows sort by the oldest or newest known use while displaying their latest use', () => {
	const rows = [
		item('COPY . .', { id: 'a', kind: 'build-cache', lastUsedAt: '2026-10-01T00:00:00Z' }),
		item('COPY . .', { id: 'b', kind: 'build-cache', lastUsedAt: '2026-10-05T00:00:00Z' }),
		item('RUN install', { id: 'c', kind: 'build-cache', lastUsedAt: '2026-10-03T00:00:00Z' }),
		item('unknown', { kind: 'build-cache' })
	];
	for (const direction of ['asc', 'desc'] as const) {
		const cache = groupDiskObjects(rows, 'last-used', direction)[0];
		assert.deepEqual(
			cache.rows.map((row) => row.name),
			['COPY . .', 'RUN install', 'unknown']
		);
		assert.equal(cache.rows[0].lastUsedAt, '2026-10-05T00:00:00Z');
	}
});
