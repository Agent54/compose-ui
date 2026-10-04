import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupDiskObjects } from '../src/lib/central/disk-objects.ts';
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
