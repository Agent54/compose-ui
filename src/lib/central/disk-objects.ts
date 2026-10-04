import type { DiskItem } from './disk-usage';

export type DiskObjectSort = 'size' | 'reclaimable' | 'last-used';
export type DiskSortDirection = 'asc' | 'desc';
type DiskTotals = {
	bytes?: number;
	reclaimableBytes?: number;
	partialBytes: boolean;
	partialReclaimableBytes: boolean;
};
export type DiskObjectRow = DiskTotals & {
	id: string;
	name: string;
	kind: string;
	items: DiskItem[];
	lastUsedAt?: string;
	candidateCount: number;
};
export type DiskObjectGroup = DiskTotals & {
	id: string;
	label: string;
	items: DiskItem[];
	rows: DiskObjectRow[];
};
type DiskService = NonNullable<DiskItem['services']>[number];

const labels: Record<string, string> = {
	shared: 'Shared',
	dangling: 'Dangling',
	'build-cache': 'Build cache',
	other: 'Other'
};

export function diskServiceLabel(service: { project?: string; name: string }): string {
	return service.project ? `${service.project} / ${service.name}` : service.name;
}

function serviceKey(service: DiskService): string {
	return JSON.stringify([service.project ?? '', service.name]);
}

const genericNames = new Set([
	'app',
	'api',
	'web',
	'db',
	'server',
	'worker',
	'client',
	'base',
	'deps',
	'builder',
	'runtime',
	'build',
	'node',
	'python',
	'redis',
	'postgres',
	'mysql',
	'data',
	'cache',
	'home',
	'root',
	'local'
]);

function mentions(name: string, token: string): boolean {
	const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'i').test(name);
}

/** Resolve against the complete report before filtering so ownership cannot change with the view. */
export function attributeDiskObjects(items: DiskItem[]): DiskItem[] {
	const known = new Map<string, DiskService>();
	for (const item of items) {
		for (const service of item.services ?? []) known.set(serviceKey(service), service);
	}
	return items.map((item) => {
		const services = [...new Map((item.services ?? []).map((s) => [serviceKey(s), s])).values()];
		if (services.length) return { ...item, services };
		if (item.kind !== 'build-cache') return item;
		const ranked = [...known.values()].map((service) => {
			if (
				service.project &&
				(mentions(item.name, `${service.project}/${service.name}`) ||
					mentions(item.name, `${service.project}-${service.name}`))
			)
				return { service, score: 3 };
			const distinctive = (name: string | undefined) =>
				name &&
				name.length >= 4 &&
				!genericNames.has(name.toLowerCase()) &&
				mentions(item.name, name);
			return {
				service,
				score: distinctive(service.name) ? 2 : distinctive(service.project) ? 1 : 0
			};
		});
		const score = ranked.reduce((highest, match) => Math.max(highest, match.score), 0);
		const matches = ranked
			.filter((match) => score > 0 && match.score === score)
			.map((match) => match.service);
		return matches.length === 1 ? { ...item, services: matches, serviceInferred: true } : item;
	});
}

function groupFor(item: DiskItem): Pick<DiskObjectGroup, 'id' | 'label'> {
	const service = item.services?.length === 1 ? item.services[0] : undefined;
	if (service) {
		return {
			id: JSON.stringify(['service', service.project ?? '', service.name]),
			label: diskServiceLabel(service)
		};
	}
	// Docker's cache Shared flag describes image-layer overlap, not service ownership.
	const kind =
		item.services && item.services.length > 1
			? 'shared'
			: item.kind === 'build-cache'
				? 'build-cache'
				: item.group && labels[item.group]
					? item.group
					: 'other';
	return { id: kind, label: labels[kind] };
}

function valueFor(
	item: Pick<DiskItem, 'lastUsedAt' | 'bytes' | 'reclaimableBytes'>,
	sort: DiskObjectSort
): number | undefined {
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

function totals(items: DiskItem[]): DiskTotals {
	const sum = (field: 'bytes' | 'reclaimableBytes') => {
		const values = items
			.map((item) => item[field])
			.filter(
				(value): value is number => value !== undefined && Number.isFinite(value) && value >= 0
			);
		return {
			value: values.length ? values.reduce((total, value) => total + value, 0) : undefined,
			partial: values.length > 0 && values.length < items.length
		};
	};
	const size = sum('bytes');
	const reclaimable = sum('reclaimableBytes');
	return {
		bytes: size.value,
		reclaimableBytes: reclaimable.value,
		partialBytes: size.partial,
		partialReclaimableBytes: reclaimable.partial
	};
}

function cacheCommand(name: string): string {
	// Step numbers vary across builds; the command itself is the useful grouping key.
	return name.replace(/^\[[^\]]*\d+\s*\/\s*\d+\]\s*/, '').trim();
}

function rowsFor(
	items: DiskItem[],
	sort: DiskObjectSort,
	direction: DiskSortDirection
): DiskObjectRow[] {
	const buckets = new Map<string, { name: string; items: DiskItem[] }>();
	for (const [index, item] of items.entries()) {
		const name = item.kind === 'build-cache' ? cacheCommand(item.name) : item.name;
		const id =
			item.kind === 'build-cache'
				? JSON.stringify([item.kind, name])
				: (item.id ?? JSON.stringify([item.kind, name, index]));
		const bucket = buckets.get(id);
		if (bucket) bucket.items.push(item);
		else buckets.set(id, { name, items: [item] });
	}
	return [...buckets.entries()]
		.map(([id, bucket]) => {
			const dated = bucket.items.filter((item) => valueFor(item, 'last-used') !== undefined);
			dated.sort((a, b) =>
				compareValues(valueFor(a, 'last-used'), valueFor(b, 'last-used'), 'desc')
			);
			return {
				id,
				name: bucket.name,
				kind: bucket.items[0].kind,
				items: bucket.items,
				...totals(bucket.items),
				lastUsedAt: dated[0]?.lastUsedAt,
				candidateCount: bucket.items.filter((item) => item.candidate).length
			};
		})
		.sort(
			(a, b) =>
				compareValues(
					sort === 'last-used' && direction === 'asc' ? oldestUse(a.items) : valueFor(a, sort),
					sort === 'last-used' && direction === 'asc' ? oldestUse(b.items) : valueFor(b, sort),
					direction
				) ||
				a.name.localeCompare(b.name) ||
				a.id.localeCompare(b.id)
		);
}

function oldestUse(items: DiskItem[]): number | undefined {
	const dates = items
		.map((item) => valueFor(item, 'last-used'))
		.filter((value): value is number => value !== undefined);
	return dates.length ? Math.min(...dates) : undefined;
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
			group = { ...key, items: [], rows: [], ...totals([]) };
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
		Object.assign(group, totals(group.items));
		group.rows = rowsFor(group.items, sort, direction);
		const known = group.items
			.map((item) => valueFor(item, sort))
			.filter((value): value is number => value !== undefined);
		// These are sums of reported object sizes; shared image layers can overlap.
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
