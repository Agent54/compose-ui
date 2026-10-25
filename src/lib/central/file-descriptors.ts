import type { ResourcePressure } from './resource-state';

export const descriptorIntervalMs = 10_000;

export type DescriptorProcess = {
	pid: number;
	name: string;
	used: number;
	softLimit?: number;
	hardLimit?: number;
	available?: number;
	truncated: boolean;
};

export type FileDescriptorSnapshot = {
	sampledAt: string;
	bootId: string;
	containerId?: string;
	vm?: { used: number; limit: number };
	processes: DescriptorProcess[];
	partial: boolean;
	processError?: string;
	inotifyWatchLimit?: number;
	watcherError?: string;
};

function finiteCount(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value >= 0;
}

export function descriptorPressure(
	available: number | undefined,
	limit: number | undefined
): ResourcePressure {
	if (!finiteCount(available) || !finiteCount(limit) || available > limit) return 'normal';
	if (limit === 0 || available / limit <= 0.05) return 'critical';
	if (available / limit <= 0.1) return 'warning';
	return 'normal';
}

function count(value: number | undefined) {
	if (!finiteCount(value)) return '—';
	return Number.isSafeInteger(value) ? value.toLocaleString() : '≈' + value.toExponential(2);
}

export function vmDescriptorMetric(snapshot: FileDescriptorSnapshot | null) {
	const vm = snapshot?.vm;
	const valid = vm && finiteCount(vm.used) && finiteCount(vm.limit) && vm.limit > 0;
	const available = valid ? Math.max(0, vm.limit - vm.used) : undefined;
	return {
		label: 'HANDLES FREE',
		value: count(available),
		tooltip: valid
			? 'VM kernel file handles\nFree ' +
				count(available) +
				' / ' +
				count(vm.limit) +
				'\nUsed ' +
				count(vm.used) +
				'\nShared by all VM processes and containers.\nSampled ' +
				snapshot.sampledAt
			: 'VM file-handle counters unavailable',
		pressure: descriptorPressure(available, valid ? vm.limit : undefined),
		descriptor: true
	};
}

export function serviceDescriptorMetric(
	snapshot: FileDescriptorSnapshot | null,
	containerId: string
) {
	const matching = snapshot?.containerId === containerId ? snapshot : null;
	const processes = matching?.processes ?? [];
	const bounded = processes.filter(
		(p) =>
			!p.truncated &&
			finiteCount(p.used) &&
			finiteCount(p.available) &&
			finiteCount(p.softLimit) &&
			p.available <= p.softLimit
	);
	const worst = bounded.reduce<DescriptorProcess | undefined>((previous, current) => {
		if (!previous) return current;
		const fraction = (p: DescriptorProcess) =>
			p.softLimit === 0 ? 0 : p.available! / p.softLimit!;
		return fraction(current) < fraction(previous) ? current : previous;
	}, undefined);
	const incomplete =
		matching?.partial || processes.some((p) => p.truncated || !finiteCount(p.available));
	return {
		label: 'FD FREE',
		value: count(worst?.available) + (incomplete ? '*' : ''),
		tooltip: worst
			? worst.name +
				' (PID ' +
				worst.pid +
				')\nFree ' +
				count(worst.available) +
				' / ' +
				count(worst.softLimit) +
				'\nOpen ' +
				count(worst.used) +
				' · hard limit ' +
				count(worst.hardLimit) +
				'\nProcess closest to its own limit in this container (' +
				processes.length +
				' sampled).' +
				(incomplete
					? '\nIncomplete sample: scan limit reached or some process counters unavailable.'
					: '') +
				'\nSampled ' +
				matching!.sampledAt
			: (matching?.processError ??
				(incomplete
					? 'Descriptor sample incomplete; scan limit reached or process counters unavailable.'
					: 'Selected container descriptor counters unavailable')),
		pressure: descriptorPressure(worst?.available, worst?.softLimit),
		descriptor: true
	};
}

export function serviceWatcherMetric(snapshot: FileDescriptorSnapshot | null, containerId: string) {
	const matching = snapshot?.containerId === containerId ? snapshot : null;
	if (!matching?.watcherError) return null;
	return {
		label: 'WATCHER',
		value: /\b(ENOSPC|EMFILE|ENFILE)\b/i.exec(matching.watcherError)?.[1].toUpperCase() ?? 'ERROR',
		tooltip:
			'File watcher error reported during this container run\n' +
			matching.watcherError +
			'\nVM inotify watch limit per user: ' +
			count(matching.inotifyWatchLimit) +
			'\nInotify watches have a separate limit from open file descriptors.\nExclude generated folders from file watching or raise the VM inotify limit, then reload the editor.\nRecovery has not been confirmed; a normal FD count does not confirm file watching recovered.',
		pressure: 'critical' as const,
		descriptor: true
	};
}

export function fileDescriptorUrl(serverUrl: string, apiVersion: string, containerId?: string) {
	const base = serverUrl.trim().replace(/\/+$/, '');
	const version = apiVersion.replace(/^v/i, '') || '1';
	return (
		base +
		'/v' +
		version +
		'/file-descriptors' +
		(containerId ? '?' + new URLSearchParams({ container: containerId }) : '')
	);
}

type PollOptions = {
	fetch?: typeof fetch;
	visible?: () => boolean;
};

// One request at a time; switching selection aborts the old request and discards
// its result. The server independently caches successful and failed scans for 10s.
export function pollFileDescriptors(
	url: string,
	update: (snapshot: FileDescriptorSnapshot | null) => void,
	options: PollOptions = {}
) {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const controller = new AbortController();
	const read = options.fetch ?? fetch;
	const visible = options.visible ?? (() => true);
	async function poll() {
		const started = performance.now();
		if (visible()) {
			try {
				const response = await read(url, {
					cache: 'no-store',
					signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)])
				});
				if (!response.ok) throw new Error('Descriptor telemetry unavailable');
				const snapshot = (await response.json()) as FileDescriptorSnapshot;
				if (!Array.isArray(snapshot.processes)) throw new Error('Invalid descriptor telemetry');
				if (!stopped) update(snapshot);
			} catch {
				if (!stopped) update(null);
			}
		}
		if (!stopped)
			timer = setTimeout(
				() => void poll(),
				Math.max(0, descriptorIntervalMs - (performance.now() - started))
			);
	}
	void poll();
	return () => {
		stopped = true;
		controller.abort();
		if (timer !== undefined) clearTimeout(timer);
	};
}
