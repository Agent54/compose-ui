import type { ComposeProject, ComposeService } from './types';

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
