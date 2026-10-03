import type { UiState } from './types';

export type DiskItem = {
	kind: string;
	name: string;
	bytes?: number;
	reclaimableBytes?: number;
	candidate: boolean;
	detail: string;
};
export type DiskReport = {
	sampledAt: string;
	categories: {
		kind: string;
		label: string;
		count: number;
		candidateCount: number;
		totalBytes?: number;
		reclaimableBytes?: number;
		note: string;
	}[];
	items: DiskItem[];
};
export type DiskUsage = {
	inventory?: {
		sampledAt: string;
		imageCount: number;
		unusedImageCount: number;
		containerCount: number;
		stoppedContainerCount: number;
		volumes: { name: string; driver: string; references: number; project?: string }[];
	};
	report?: DiskReport;
	scanError?: string;
	nextScanAt?: string | null;
};

export type DiskCleanup = {
	running: boolean;
	lastAttemptAt?: string;
	completedAt?: string;
	nextRunAt?: string;
	imageMinimumAgeHours: number;
	intervalHours: number;
	buildCacheLimit: string;
	results: { name: string; reclaimedBytes?: number; error?: string }[];
};

export function loadDiskUsage(
	ui: Pick<UiState, 'serverUrl' | 'apiVersion'>,
	scan = false,
	signal?: AbortSignal
): Promise<DiskUsage> {
	return requestDiskUsage(
		ui,
		scan ? '/scan' : '',
		scan ? 'POST' : 'GET',
		scan ? 65_000 : 6000,
		signal
	);
}

export function loadDiskCleanup(
	ui: Pick<UiState, 'serverUrl' | 'apiVersion'>,
	run = false,
	signal?: AbortSignal
): Promise<DiskCleanup> {
	return requestDiskUsage(ui, '/cleanup', run ? 'POST' : 'GET', 6000, signal);
}
async function requestDiskUsage<T>(
	ui: Pick<UiState, 'serverUrl' | 'apiVersion'>,
	suffix: string,
	method: 'GET' | 'POST',
	timeout: number,
	signal?: AbortSignal
): Promise<T> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	signal?.addEventListener('abort', abort, { once: true });
	const timer = setTimeout(abort, timeout);
	try {
		const base = ui.serverUrl.trim().replace(/\/+$/, '');
		const version = ui.apiVersion.replace(/^v/i, '') || '1';
		const response = await fetch(`${base}/v${version}/disk-usage${suffix}`, {
			method,
			headers: { accept: 'application/json' },
			signal: controller.signal
		});
		const payload = await response.json();
		if (!response.ok) throw new Error(payload.message || `Disk usage failed (${response.status}).`);
		return payload as T;
	} catch (error) {
		if (controller.signal.aborted && !signal?.aborted) {
			throw new Error('Disk usage request timed out.');
		}
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', abort);
	}
}
