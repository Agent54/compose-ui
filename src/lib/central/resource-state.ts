import { latestBuildFailure } from './build-state';
import type { ComposeBuild, RuntimeStatus } from './types';

export type ResourcePressure = 'normal' | 'warning' | 'critical';

// Resource failures can be absent from the next utilization sample. Keep the
// latest failed build's diagnostic visible after recovery and during retries.
export function memoryBuildFailures(
	builds: ComposeBuild[],
	output: Array<{ buildId: string; message: string }>
) {
	return resourceBuildFailures(
		builds,
		output,
		/\bcannot allocate memory\b|\bout of memory\b|\bENOMEM\b|\boom[-_ ]?killed\b/i
	);
}

export function diskBuildFailures(
	builds: ComposeBuild[],
	output: Array<{ buildId: string; message: string }>
) {
	return resourceBuildFailures(
		builds,
		output,
		/\bno space left on device\b|\bENOSPC\b|\bdisk quota exceeded\b|\bEDQUOT\b/i
	);
}

function resourceBuildFailures(
	builds: ComposeBuild[],
	output: Array<{ buildId: string; message: string }>,
	pattern: RegExp
) {
	const completed = builds.filter((build) => build.status !== 'running');
	const failures = new Map<string, string>();
	for (const entry of output) {
		if (pattern.test(entry.message)) {
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

export type RuntimeMemoryWarning = {
	id?: string;
	title: string;
	message: string;
	occurredAt?: string;
	memoryLimitBytes?: number;
};

export function runtimeMemoryWarning(
	runtime: RuntimeStatus | null,
	dismissedIncidentId = ''
): RuntimeMemoryWarning | null {
	const incident = runtime?.lastIncident;
	if (incident?.reason === 'oom' && incident.id !== dismissedIncidentId) {
		return { ...incident, title: 'VM ran out of memory' };
	}
	const total = runtime?.memoryTotalBytes;
	const available = runtime?.memoryAvailableBytes;
	if (
		runtime?.phase === 'healthy' &&
		total !== undefined &&
		Number.isFinite(total) &&
		total > 0 &&
		available !== undefined &&
		Number.isFinite(available) &&
		available >= 0 &&
		available <= total * 0.1
	) {
		return {
			title: 'VM memory is almost full',
			message: 'Pause builds or increase VM memory in Xe Launcher to avoid processes being killed.',
			memoryLimitBytes: total
		};
	}
	return null;
}
