import type { VMResources } from './types';

type ByteFormatter = (value: number | undefined) => string;

// These gauges describe the VM on the host, separately from guest usage.
// Reclaimed free pages are not the same as an inflated balloon; a zero
// balloon is a valid reading and says nothing about resident RAM by itself.
export function vmHostMetrics(resources: VMResources | undefined, formatBytes: ByteFormatter) {
	if (!resources) return [];
	const metrics = [];
	if (resources.memoryResidentBytes !== undefined) {
		metrics.push({
			label: 'HOST RAM',
			value: formatBytes(resources.memoryResidentBytes),
			tooltip: `VM resident RAM on the host\n${formatBytes(resources.memoryResidentBytes)} resident / ${formatBytes(resources.memoryLimitBytes)} configured guest limit\nIncludes VM process overhead; excludes compressed and swapped pages.`
		});
	}
	if (resources.balloonInflatedBytes !== undefined) {
		metrics.push({
			label: 'BALLOON',
			value: formatBytes(resources.balloonInflatedBytes),
			tooltip: `Virtio balloon\n${formatBytes(resources.balloonInflatedBytes)} inflated / ${formatBytes(resources.balloonTargetBytes)} target\nFree-page reporting can reclaim RAM while the balloon is zero.`
		});
	}
	if (resources.diskAllocatedBytes !== undefined) {
		metrics.push({
			label: 'IMAGE',
			value: formatBytes(resources.diskAllocatedBytes),
			tooltip: `VM disk images on the host\n${formatBytes(resources.diskAllocatedBytes)} allocated blocks / ${formatBytes(resources.diskLogicalBytes)} logical file size\nStorage and overlay images; sparse holes consume no host blocks.`
		});
	}
	return metrics;
}
