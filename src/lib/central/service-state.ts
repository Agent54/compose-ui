import type { ComposeService } from './types';

export function isExpectedServiceStop(
	service: Pick<ComposeService, 'state' | 'stateText'>
) {
	if (service.state !== 'exited') {
		return false;
	}

	const status = service.stateText.trim();
	return /^exited\s*\(0\)(?:\s|$)/i.test(status) || /^stopped(?:\s|$)/i.test(status);
}
