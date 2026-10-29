import type { ComposeBuild, ComposeProject, ComposeService } from './types';
import {
	actionTargetsOverlap,
	hasActiveAction,
	type ServiceAction,
	type ServiceActionTarget
} from './action-state';

const actionStatuses = {
	start: 'starting',
	'up-no-build': 'starting',
	unpause: 'starting',
	stop: 'stopping',
	restart: 'restarting',
	remove: 'removing',
	pause: 'pausing',
	watching: 'updating watch'
} as const;

type PendingTarget = ServiceActionTarget & { projectName: string; serviceName?: string };
type PendingService = Pick<
	ComposeService,
	'id' | 'projectId' | 'projectName' | 'serviceName' | 'state'
>;

function activeActionStatus(target: ServiceActionTarget, activeActions: readonly ServiceAction[]) {
	const action = activeActions.find((action) => actionTargetsOverlap(action, target));
	return action ? (actionStatuses[action.kind as keyof typeof actionStatuses] ?? '') : '';
}

// A project has the same scope as all of its children. Only the target changes;
// requests and builds are resolved identically at both levels.
function pendingStatus(
	target: PendingTarget,
	builds: readonly ComposeBuild[],
	activeActions: readonly ServiceAction[],
	restarting: boolean
) {
	const action = activeActionStatus(target, activeActions);
	if (action) return action;
	if (restarting) return 'restarting';
	if (
		builds.some((build) => {
			if (
				build.status !== 'running' ||
				(build.projectId !== target.projectId && build.projectName !== target.projectName)
			)
				return false;
			const names = build.serviceNames?.length
				? build.serviceNames
				: build.serviceName
					? [build.serviceName]
					: [];
			return !target.serviceName || !names.length || names.includes(target.serviceName);
		})
	)
		return 'building';
	return '';
}

export function projectStateRank(
	state: ComposeProject['state'] | ComposeService['state'] | 'mixed'
) {
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
	service: PendingService,
	builds: readonly ComposeBuild[],
	activeActions: readonly ServiceAction[] = []
) {
	return pendingStatus(
		{
			projectId: service.projectId,
			projectName: service.projectName,
			serviceId: service.id,
			serviceName: service.serviceName
		},
		builds,
		activeActions,
		service.state === 'restarting'
	);
}

export function projectPendingStatus(
	project: Pick<ComposeProject, 'id' | 'name' | 'state' | 'statusLabel'>,
	services: readonly PendingService[],
	builds: readonly ComposeBuild[],
	activeActions: readonly ServiceAction[] = []
) {
	return (
		pendingStatus(
			{ projectId: project.id, projectName: project.name },
			builds,
			activeActions,
			isProjectRestarting(project, services, activeActions)
		) ||
		services
			.filter((service) => service.projectId === project.id)
			.map((service) => servicePendingStatus(service, builds, activeActions))
			.find(Boolean) ||
		''
	);
}

export function isServiceRestarting(
	service: Pick<ComposeService, 'id' | 'projectId' | 'state'>,
	activeActions: readonly ServiceAction[] = []
) {
	return (
		service.state === 'restarting' ||
		hasActiveAction(
			activeActions,
			{ projectId: service.projectId, serviceId: service.id },
			'restart'
		)
	);
}

export function isProjectRestarting(
	project: Pick<ComposeProject, 'id' | 'state' | 'statusLabel'>,
	services: ReadonlyArray<Pick<ComposeService, 'id' | 'projectId' | 'state'>>,
	activeActions: readonly ServiceAction[] = []
) {
	return (
		project.state === 'restarting' ||
		hasActiveAction(activeActions, { projectId: project.id }, 'restart') ||
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
