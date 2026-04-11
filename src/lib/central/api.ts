import type { ComposeProject, ComposeService, UiState } from './types';

type ListedProject = {
	name?: string;
	Name?: string;
	project?: string;
	id?: string;
	ID?: string;
	path?: string;
	dir?: string;
	directory?: string;
	ConfigFiles?: string;
	watch?: boolean;
	watchActive?: boolean;
	watch_active?: boolean;
	running?: boolean;
	active?: boolean;
	state?: string;
	status?: string;
	Status?: string;
};

type RefreshResult = {
	projects: ComposeProject[];
	services: ComposeService[];
};

function slugify(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function normalizeVersion(version: string) {
	return version.replace(/^v/i, '') || '1';
}

function joinUrl(serverUrl: string, version: string, path: string) {
	const base = serverUrl.trim().replace(/\/+$/, '');
	return `${base}/v${normalizeVersion(version)}${path}`;
}

function toProject(raw: ListedProject, index: number): ComposeProject {
	const name = raw.Name ?? raw.name ?? raw.project ?? raw.ID ?? raw.id ?? `project-${index + 1}`;
	const sourceId = raw.ID ?? raw.id ?? name;
	const id = slugify(sourceId);
	const rawStatus = String(raw.Status ?? raw.status ?? raw.state ?? '').trim();
	const stateValue = rawStatus.toLowerCase();
	const statusMatch = /^([a-z-]+)(?:\((\d+)\))?$/i.exec(rawStatus);
	const statusName = statusMatch?.[1]?.toLowerCase() ?? stateValue;
	const containerCount = Number(statusMatch?.[2] ?? 0);
	const isRunning =
		raw.running === true ||
		raw.active === true ||
		statusName === 'running' ||
		stateValue === 'up';
	const isExited = statusName === 'exited';
	const isUncreated = statusName === 'uncreated';

	return {
		id,
		name,
		path: raw.ConfigFiles ?? raw.path ?? raw.dir ?? raw.directory ?? `./${name}`,
		state: isRunning ? 'running' : isExited ? 'exited' : isUncreated ? 'uncreated' : 'stopped',
		statusLabel: rawStatus || 'unknown',
		containerCount,
		watch: raw.watch === true || raw.watchActive === true || raw.watch_active === true,
		expanded: false,
		updatedLabel: 'just now'
	};
}

function parseProjects(payload: unknown) {
	if (Array.isArray(payload)) {
		return payload as ListedProject[];
	}

	if (payload && typeof payload === 'object') {
		const objectPayload = payload as { projects?: unknown; items?: unknown };

		if (Array.isArray(objectPayload.projects)) {
			return objectPayload.projects as ListedProject[];
		}

		if (Array.isArray(objectPayload.items)) {
			return objectPayload.items as ListedProject[];
		}
	}

	return [];
}

export async function refreshProjectsFromServer(ui: UiState): Promise<RefreshResult> {
	const params = new URLSearchParams();
	params.set('all', 'true');

	if (ui.filter.trim()) {
		params.append('filter', `name=${ui.filter.trim()}`);
	}

	const response = await fetch(`${joinUrl(ui.serverUrl, ui.apiVersion, '/ls')}?${params.toString()}`, {
		headers: {
			accept: 'application/json'
		}
	});

	if (!response.ok) {
		throw new Error(`ls returned ${response.status}`);
	}

	const payload = (await response.json()) as unknown;
	const projects = parseProjects(payload).map(toProject);

	return {
		projects,
		services: []
	};
}

export async function checkHealth(ui: UiState) {
	const response = await fetch(joinUrl(ui.serverUrl, ui.apiVersion, '/_ping'), {
		method: 'GET',
		headers: {
			accept: 'application/json'
		}
	});

	if (!response.ok) {
		throw new Error(`/_ping returned ${response.status}`);
	}
}

export async function startProject(ui: UiState, path: string, watch: boolean) {
	const response = await fetch(joinUrl(ui.serverUrl, ui.apiVersion, '/up'), {
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		},
		body: JSON.stringify({ path, build: false, watch })
	});

	if (!response.ok) {
		throw new Error(`up returned ${response.status}`);
	}
}

export async function startWatch(ui: UiState, project: string, path?: string) {
	const response = await fetch(joinUrl(ui.serverUrl, ui.apiVersion, `/watch/${project}`), {
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		},
		body: JSON.stringify(path ? { path } : {})
	});

	if (!response.ok) {
		throw new Error(`watch start returned ${response.status}`);
	}
}

export async function stopWatch(ui: UiState, project: string) {
	const response = await fetch(joinUrl(ui.serverUrl, ui.apiVersion, `/watch/${project}`), {
		method: 'DELETE'
	});

	if (!response.ok) {
		throw new Error(`watch stop returned ${response.status}`);
	}
}
