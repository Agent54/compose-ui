export type ResourcePressure = 'normal' | 'warning' | 'critical';

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
