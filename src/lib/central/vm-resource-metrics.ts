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
					? 'VM Docker disk free space unavailable'
					: `Docker storage inside the VM (/storage/docker)\n${formatBytes(available)} available for writes / ${formatBytes(total)} total\n${freeInodes?.toLocaleString() ?? '—'} / ${totalInodes?.toLocaleString() ?? '—'} free inodes\nSampled at most once per minute.${available === 0 ? '\nDisk is full: no space available for writes.' : ''}${freeInodes === 0 ? '\nNo free inodes; new files cannot be created.' : ''}`,
			percent,
			pressure:
				available === 0 || freeInodes === 0
					? ('critical' as const)
					: resourcePressure(Math.max(percent ?? 0, inodePercent ?? 0))
		}
	];
}

// These gauges describe the VM on the host, separately from guest usage.
// Reclaimed free pages are not the same as an inflated balloon; a zero
// balloon is a valid reading and says nothing about resident RAM by itself.
export function vmHostMetrics(resources: VMResources | undefined, formatBytes: ByteFormatter) {
	const metrics = [];
	if (resources?.memoryResidentBytes !== undefined) {
		metrics.push({
			label: 'HOST RAM',
			value: formatBytes(resources.memoryResidentBytes),
			tooltip: `VM resident RAM on the host\n${formatBytes(resources.memoryResidentBytes)} resident / ${formatBytes(resources.memoryLimitBytes)} configured guest limit\nIncludes VM process overhead; excludes compressed and swapped pages.`
		});
	}
	if (resources?.balloonInflatedBytes !== undefined) {
		metrics.push({
			label: 'BALLOON',
			value: formatBytes(resources.balloonInflatedBytes),
			tooltip: `Virtio balloon\n${formatBytes(resources.balloonInflatedBytes)} inflated / ${formatBytes(resources.balloonTargetBytes)} target\nFree-page reporting can reclaim RAM while the balloon is zero.`
		});
	}
	metrics.push({
		label: 'IMAGE',
		value:
			resources?.diskAllocatedBytes === undefined ? '—' : formatBytes(resources.diskAllocatedBytes),
		tooltip:
			resources?.diskAllocatedBytes === undefined
				? 'VM disk image allocation unavailable'
				: `VM disk images on the host\n${formatBytes(resources.diskAllocatedBytes)} allocated blocks / ${formatBytes(resources.diskLogicalBytes)} logical file size\nStorage and overlay images; sparse holes consume no host blocks. Sampled at most once per minute.\nSee DISK FREE for space available inside the VM.`
	});
	return metrics;
}
