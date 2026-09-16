import type { ComposeBuild, ComposeProject, ComposeService } from './types';

export function isReplacementBuild(previous: ComposeBuild | undefined, incoming: ComposeBuild) {
	// The server's in-memory registry restarts its ID counter after a restart.
	if (previous?.serverStartedAt && incoming.serverStartedAt) {
		return previous.serverStartedAt !== incoming.serverStartedAt;
	}
	return Boolean(
		previous?.finishedAt && Date.parse(incoming.startedAt) > Date.parse(previous.finishedAt)
	);
}

export function mergeBuilds(current: ComposeBuild[], incoming: ComposeBuild[]) {
	const merged = new Map(current.map((build) => [build.id, build]));
	for (const build of incoming) {
		const existing = merged.get(build.id);
		const previous = isReplacementBuild(existing, build) ? undefined : existing;
		if (!previous) {
			merged.set(build.id, build);
			continue;
		}
		// A poll started before completion must not put a completed build back in progress.
		merged.set(build.id, {
			...previous,
			...build,
			projectId: previous?.projectId ?? build.projectId,
			targetName: previous?.targetName ?? build.targetName,
			serviceName: previous?.serviceName ?? build.serviceName,
			...(previous?.status !== 'running' && previous && build.status === 'running'
				? { status: previous.status, success: previous.success, finishedAt: previous.finishedAt }
				: {})
		});
	}
	return [...merged.values()];
}

export function latestBuildFailure(
	builds: ComposeBuild[],
	project: Pick<ComposeProject, 'id' | 'name'>,
	service?: Pick<ComposeService, 'serviceName'>
) {
	const matching = builds
		.filter(
			(build) =>
				(build.projectId === project.id || build.projectName === project.name) &&
				(!service || !build.serviceName || build.serviceName === service.serviceName)
		)
		.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
	if (service) return matching[0]?.status === 'failed' ? matching[0] : undefined;
	const covered = new Set<string>();
	for (const build of matching) {
		if (build.serviceName && covered.has(build.serviceName)) continue;
		if (build.status === 'failed') return build;
		if (!build.serviceName) break;
		covered.add(build.serviceName);
	}
	return undefined;
}
