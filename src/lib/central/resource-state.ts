import { latestBuildFailure } from './build-state';
import type { ComposeBuild } from './types';

export type ResourcePressure = 'normal' | 'warning' | 'critical';

// Allocation failures need not kill a process, and memory is often free again
// by the next sample. Keep the failed build's diagnostic visible after recovery.
export function memoryBuildFailures(
	builds: ComposeBuild[],
	output: Array<{ buildId: string; message: string }>
) {
	const completed = builds.filter((build) => build.status !== 'running');
	const failures = new Map<string, string>();
	for (const entry of output) {
		if (
			/\bcannot allocate memory\b|\bout of memory\b|\bENOMEM\b|\boom[-_ ]?killed\b/i.test(
				entry.message
			)
		) {
			failures.set(entry.buildId, entry.message);
		}
	}
	return completed
		.filter((build) => build.status === 'failed' && failures.has(build.id))
		.filter(
			(build) =>
				latestBuildFailure(
					completed,
					{ id: build.projectId, name: build.projectName },
					build.serviceName ? { serviceName: build.serviceName } : undefined
				)?.id === build.id
		)
		.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
		.map((build) => ({ build, message: failures.get(build.id)! }));
}

export function resourcePressure(percent: number | undefined): ResourcePressure {
	if (percent === undefined || !Number.isFinite(percent)) {
		return 'normal';
	}

	if (percent >= 95) {
		return 'critical';
	}

	if (percent >= 80) {
		return 'warning';
	}

	return 'normal';
}
