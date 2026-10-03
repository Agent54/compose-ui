import type { VMResources } from './types';
import { resourcePressure } from './resource-state';

type ByteFormatter = (value: number | undefined) => string;

export function vmDiskMetrics(resources: VMResources | undefined, formatBytes: ByteFormatter) {
	const available = resources?.diskAvailableBytes;
	const total = resources?.diskTotalBytes;
	const freeInodes = resources?.diskFreeInodes;
	const totalInodes = resources?.diskTotalInodes;
	const percent =
		available !== undefined && total !== undefined && total > 0
			? ((total - available) / total) * 100
			: undefined;
	const inodePercent =
		freeInodes !== undefined && totalInodes !== undefined && totalInodes > 0
			? ((totalInodes - freeInodes) / totalInodes) * 100
			: undefined;
	return [
		{
			label: 'DISK FREE',
			value:
				(available === undefined ? '—' : formatBytes(available)) +
				(freeInodes === 0 ? ' · 0 inodes' : ''),
			tooltip:
				available === undefined
					? 'VM disk free space unavailable'
					: `VM disk\nFree ${formatBytes(available)} / ${formatBytes(total)}\nInodes ${freeInodes?.toLocaleString() ?? '—'} / ${totalInodes?.toLocaleString() ?? '—'}${available === 0 ? '\nDisk full' : ''}${freeInodes === 0 ? '\nNo free inodes' : ''}`,
			percent,
			pressure:
				available === 0 || freeInodes === 0
					? ('critical' as const)
					: resourcePressure(Math.max(percent ?? 0, inodePercent ?? 0))
		}
	];
}

// These gauges describe the VM on the host, separately from guest usage.
export function vmHostMetrics(resources: VMResources | undefined, formatBytes: ByteFormatter) {
	const metrics = [];
	if (resources?.memoryResidentBytes !== undefined) {
		metrics.push({
			label: 'HOST RAM',
			value: formatBytes(resources.memoryResidentBytes),
			tooltip: `VM resident memory\n${formatBytes(resources.memoryResidentBytes)} resident / ${formatBytes(resources.memoryLimitBytes)} guest limit`
		});
	}
	metrics.push({
		label: 'IMAGE',
		value:
			resources?.diskAllocatedBytes === undefined ? '—' : formatBytes(resources.diskAllocatedBytes),
		tooltip:
			resources?.diskAllocatedBytes === undefined
				? 'VM disk images unavailable'
				: `VM disk images\n${formatBytes(resources.diskAllocatedBytes)} allocated / ${formatBytes(resources.diskLogicalBytes)} logical`
	});
	return metrics;
}
