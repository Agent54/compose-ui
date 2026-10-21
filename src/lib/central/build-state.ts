import type { ComposeBuild, ComposeProject, ComposeService } from './types';

export function buildTitle(build: ComposeBuild) {
	if (build.kind === 'watch') return `${build.targetName || build.projectName} watch`;

	const target = build.serviceNames?.join(', ') || build.serviceName || build.targetName;
	const label = target ? `${build.projectName} / ${target}` : build.projectName;
	return label ? `${label} build #${build.id}` : `Build #${build.id}`;
}

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
			targetName: build.targetName ?? previous.targetName,
			serviceName: build.serviceNames?.length
				? build.serviceName
				: (build.serviceName ?? previous.serviceName),
			serviceNames: build.serviceNames ?? previous.serviceNames,
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
	// A project build can recover all services, but its failure does not identify
	// which service failed. Keep that warning on the project rather than every child.
	const matching = builds
		.filter(
			(build) =>
				(build.projectId === project.id || build.projectName === project.name) &&
				(!service ||
					build.serviceNames?.includes(service.serviceName) ||
					build.serviceName === service.serviceName ||
					(!build.serviceName && !build.serviceNames?.length && build.status !== 'failed'))
		)
		.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
	if (service) return matching[0]?.status === 'failed' ? matching[0] : undefined;
	const covered = new Set<string>();
	for (const build of matching) {
		const names = build.serviceNames?.length
			? build.serviceNames
			: build.serviceName
				? [build.serviceName]
				: [];
		if (names.length && names.every((name) => covered.has(name))) continue;
		if (build.status === 'failed') return build;
		if (!names.length) break;
		for (const name of names) covered.add(name);
	}
	return undefined;
}
