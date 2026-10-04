import type { DiskItem } from './disk-usage';

export type DiskObjectSort = 'size' | 'reclaimable' | 'last-used';
export type DiskSortDirection = 'asc' | 'desc';
export type DiskObjectGroup = { id: string; label: string; items: DiskItem[] };

const labels: Record<string, string> = {
	shared: 'Shared',
	dangling: 'Dangling',
	'build-cache': 'Build cache',
	other: 'Other'
};

export function diskServiceLabel(service: { project?: string; name: string }): string {
	return service.project ? `${service.project} / ${service.name}` : service.name;
}

function groupFor(item: DiskItem): Pick<DiskObjectGroup, 'id' | 'label'> {
	const service =
		item.group === 'service' && item.services?.length === 1 ? item.services[0] : undefined;
	if (service) {
		return {
			id: JSON.stringify(['service', service.project ?? '', service.name]),
			label: diskServiceLabel(service)
		};
	}
	const kind =
		item.group && labels[item.group]
			? item.group
			: item.kind === 'build-cache'
				? 'build-cache'
				: 'other';
	return { id: kind, label: labels[kind] };
}

function valueFor(item: DiskItem, sort: DiskObjectSort): number | undefined {
	const value =
		sort === 'last-used'
			? item.lastUsedAt
				? Date.parse(item.lastUsedAt)
				: undefined
			: sort === 'reclaimable'
				? item.reclaimableBytes
				: item.bytes;
	return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function compareValues(
	a: number | undefined,
	b: number | undefined,
	direction: DiskSortDirection
): number {
	if (a === undefined) return b === undefined ? 0 : 1;
	if (b === undefined) return -1;
	return direction === 'asc' ? a - b : b - a;
}

export function groupDiskObjects(
	items: DiskItem[],
	sort: DiskObjectSort = 'size',
	direction: DiskSortDirection = 'desc'
): DiskObjectGroup[] {
	const groups = new Map<string, DiskObjectGroup>();
	for (const item of items) {
		const key = groupFor(item);
		let group = groups.get(key.id);
		if (!group) {
			group = { ...key, items: [] };
			groups.set(key.id, group);
		}
		group.items.push(item);
	}
	const ranked = [...groups.values()].map((group) => {
		group.items.sort(
			(a, b) =>
				compareValues(valueFor(a, sort), valueFor(b, sort), direction) ||
				a.name.localeCompare(b.name) ||
				(a.id ?? a.kind).localeCompare(b.id ?? b.kind)
		);
		const known = group.items
			.map((item) => valueFor(item, sort))
			.filter((value): value is number => value !== undefined);
		// Group sizes are ranking metadata, never presented as additional physical disk usage.
		const value =
			known.length === 0
				? undefined
				: sort === 'last-used'
					? known.reduce((edge, current) =>
							direction === 'asc' ? Math.min(edge, current) : Math.max(edge, current)
						)
					: known.reduce((total, current) => total + current, 0);
		return { group, value };
	});
	return ranked
		.sort(
			(a, b) =>
				compareValues(a.value, b.value, direction) ||
				a.group.label.localeCompare(b.group.label) ||
				a.group.id.localeCompare(b.group.id)
		)
		.map(({ group }) => group);
}
