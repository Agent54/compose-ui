import type { ComposeBuild, ComposeProject, ComposeService } from './types';
import { actionTargetsOverlap, type ServiceAction } from './action-queue';

export function projectStateRank(state: ComposeProject['state'] | ComposeService['state'] | 'mixed') {
	if (state === 'running' || state === 'restarting') return 0;
	if (state === 'paused') return 1;
	if (state === 'mixed') return 2;
	if (state === 'exited' || state === 'stopped') return 3;
	if (state === 'created' || state === 'unknown') return 4;
	if (state === 'uncreated') return 5;
	return 6;
}

export function serviceStateRank(state: ComposeService['state']) {
	if (state === 'running' || state === 'restarting') return 0;
	if (state === 'paused') return 1;
	if (state === 'exited') return 2;
	if (state === 'created') return 3;
	if (state === 'unknown') return 4;
	if (state === 'uncreated') return 5;
	return 6;
}

export function servicePendingStatus(
	service: Pick<ComposeService, 'id' | 'projectId' | 'projectName' | 'serviceName' | 'state'>,
	builds: readonly ComposeBuild[],
	busyAction: string | null = null,
	queuedActions: readonly ServiceAction[] = []
) {
	const matches = (kind: string) =>
		busyAction === `${kind}:${service.projectId}:project` ||
		busyAction === `${kind}:${service.projectId}:${service.id}`;

	if (matches('stop')) return 'stopping';
	if (isServiceRestarting(service, busyAction)) return 'restarting';
	if (matches('remove')) return 'removing';
	if (matches('start') || matches('up-no-build') || matches('watching') || matches('unpause'))
		return 'starting';

	const building = builds.some((build) => {
		if (
			build.status !== 'running' ||
			(build.projectId !== service.projectId && build.projectName !== service.projectName)
		) {
			return false;
		}

		const names = build.serviceNames?.length
			? build.serviceNames
			: build.serviceName
				? [build.serviceName]
				: [];
		return !names.length || names.includes(service.serviceName);
	});

	if (building) return 'building';
	return queuedActions.some((action) =>
		actionTargetsOverlap(action, {
			projectId: service.projectId,
			serviceId: service.id
		})
	)
		? 'queued'
		: '';
}

export function isServiceRestarting(
	service: Pick<ComposeService, 'id' | 'projectId' | 'state'>,
	busyAction: string | null = null
) {
	return (
		service.state === 'restarting' ||
		busyAction === `restart:${service.projectId}:${service.id}` ||
		busyAction === `restart:${service.projectId}:project`
	);
}

export function isProjectRestarting(
	project: Pick<ComposeProject, 'id' | 'state' | 'statusLabel'>,
	services: ReadonlyArray<Pick<ComposeService, 'id' | 'projectId' | 'state'>>,
	busyAction: string | null = null
) {
	return (
		project.state === 'restarting' ||
		Boolean(busyAction?.startsWith(`restart:${project.id}:`)) ||
		[...project.statusLabel.matchAll(/\brestarting\b(?:\((\d+)\))?/gi)].some(
			(match) => match[1] === undefined || Number(match[1]) > 0
		) ||
		services.some((service) => service.projectId === project.id && isServiceRestarting(service))
	);
}

export function isExpectedServiceStop(service: Pick<ComposeService, 'state' | 'stateText'>) {
	if (service.state !== 'exited') {
		return false;
	}

	const status = service.stateText.trim();
	return /^exited\s*\(0\)(?:\s|$)/i.test(status) || /^stopped(?:\s|$)/i.test(status);
}

export function hasFailedServicesOutsideTransition(
	services: ReadonlyArray<Pick<ComposeService, 'id' | 'state' | 'stateText'>>,
	transitioningServiceIds: readonly string[]
) {
	return services.some(
		(service) =>
			!transitioningServiceIds.includes(service.id) &&
			service.state === 'exited' &&
			!isExpectedServiceStop(service)
	);
}

export function areProjectServicesStoppedWithoutError(
	services: Array<Pick<ComposeService, 'state' | 'stateText'>>
) {
	return (
		services.length > 0 &&
		services.every(
			(service) =>
				service.state === 'created' ||
				service.state === 'uncreated' ||
				isExpectedServiceStop(service)
		)
	);
}
