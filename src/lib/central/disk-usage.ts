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

export async function loadDiskUsage(
	ui: Pick<UiState, 'serverUrl' | 'apiVersion'>,
	scan = false,
	signal?: AbortSignal
): Promise<DiskUsage> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	signal?.addEventListener('abort', abort, { once: true });
	const timer = setTimeout(abort, scan ? 65_000 : 6000);
	try {
		const base = ui.serverUrl.trim().replace(/\/+$/, '');
		const version = ui.apiVersion.replace(/^v/i, '') || '1';
		const response = await fetch(`${base}/v${version}/disk-usage${scan ? '/scan' : ''}`, {
			method: scan ? 'POST' : 'GET',
			headers: { accept: 'application/json' },
			signal: controller.signal
		});
		const payload = await response.json();
		if (!response.ok) throw new Error(payload.message || `Disk usage failed (${response.status}).`);
		return payload as DiskUsage;
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
