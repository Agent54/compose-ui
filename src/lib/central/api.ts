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

type ListedContainer = {
	ID?: string;
	Id?: string;
	id?: string;
	Name?: string;
	name?: string;
	Names?: string | string[];
	Service?: string;
	service?: string;
	Project?: string;
	project?: string;
	State?: string;
	state?: string;
	Status?: string;
	status?: string;
	Health?: string;
	health?: string;
};

type RefreshResult = {
	projects: ComposeProject[];
	services: ComposeService[];
};

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
	const id = String(sourceId).trim() || `project-${index + 1}`;
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
		watching: raw.watch === true || raw.watchActive === true || raw.watch_active === true,
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

function parseServiceState(rawState: string, rawStatus: string): ComposeService['state'] {
	const state = rawState.trim().toLowerCase();
	const status = rawStatus.trim().toLowerCase();

	if (state === 'running' || status.startsWith('up ')) {
		return 'running';
	}

	if (state === 'paused' || status.includes('paused')) {
		return 'paused';
	}

	if (state === 'exited' || state === 'dead' || status.startsWith('exited')) {
		return 'exited';
	}

	if (state === 'created') {
		return 'created';
	}

	return 'unknown';
}

function parseHealth(raw: ListedContainer): ComposeService['health'] {
	const health = String(raw.Health ?? raw.health ?? '').trim().toLowerCase();

	if (health === 'healthy' || health === 'unhealthy') {
		return health;
	}

	const status = String(raw.Status ?? raw.status ?? '').toLowerCase();

	if (status.includes('healthy')) {
		return 'healthy';
	}

	if (status.includes('unhealthy')) {
		return 'unhealthy';
	}

	return undefined;
}

function parseContainerName(raw: ListedContainer, fallback: string) {
	const names = raw.Names;

	if (Array.isArray(names) && names.length) {
		return names[0]?.replace(/^\//, '') || fallback;
	}

	if (typeof names === 'string' && names.trim()) {
		return names.replace(/^\//, '');
	}

	return fallback;
}

function toService(raw: ListedContainer, project: ComposeProject, index: number): ComposeService {
	const serviceName = String(raw.Service ?? raw.service ?? raw.Name ?? raw.name ?? `service-${index + 1}`);
	const containerName = parseContainerName(
		raw,
		String(raw.Name ?? raw.name ?? serviceName)
	);
	const containerId = String(raw.ID ?? raw.Id ?? raw.id ?? `${project.id}-${serviceName}-${index + 1}`);
	const rawState = String(raw.State ?? raw.state ?? '').trim();
	const rawStatus = String(raw.Status ?? raw.status ?? rawState).trim();

	return {
		id: `${project.id}:${containerId}`,
		projectId: project.id,
		name: serviceName,
		serviceName,
		containerName,
		state: parseServiceState(rawState, rawStatus),
		stateText: rawStatus || rawState || 'unknown',
		health: parseHealth(raw)
	};
}

function parseServices(payload: unknown) {
	if (Array.isArray(payload)) {
		return payload as ListedContainer[];
	}

	if (payload && typeof payload === 'object') {
		const objectPayload = payload as { containers?: unknown; services?: unknown; items?: unknown };

		if (Array.isArray(objectPayload.containers)) {
			return objectPayload.containers as ListedContainer[];
		}

		if (Array.isArray(objectPayload.services)) {
			return objectPayload.services as ListedContainer[];
		}

		if (Array.isArray(objectPayload.items)) {
			return objectPayload.items as ListedContainer[];
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

export async function startProject(ui: UiState, path: string, watching: boolean) {
	const response = await fetch(joinUrl(ui.serverUrl, ui.apiVersion, '/up'), {
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		},
		body: JSON.stringify({ path, build: false, watch: watching })
	});

	if (!response.ok) {
		throw new Error(`up returned ${response.status}`);
	}
}

async function postProjectAction(
	ui: UiState,
	path: string,
	endpoint: string,
	projectId: string,
	body: Record<string, unknown>
) {
	const response = await fetch(joinUrl(ui.serverUrl, ui.apiVersion, `/${endpoint}/${projectId}`), {
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		},
		body: JSON.stringify({ path, ...body })
	});

	if (!response.ok) {
		throw new Error(`${endpoint} returned ${response.status}`);
	}
}

export async function startServices(
	ui: UiState,
	project: Pick<ComposeProject, 'id' | 'path'>,
	services?: string[]
) {
	await postProjectAction(ui, project.path, 'start', project.id, {
		...(services?.length ? { services } : {}),
		wait: false
	});
}

export async function stopServices(
	ui: UiState,
	project: Pick<ComposeProject, 'id' | 'path'>,
	services?: string[]
) {
	await postProjectAction(ui, project.path, 'stop', project.id, {
		...(services?.length ? { services } : {})
	});
}

export async function pauseServices(
	ui: UiState,
	project: Pick<ComposeProject, 'id' | 'path'>,
	services?: string[]
) {
	await postProjectAction(ui, project.path, 'pause', project.id, {
		...(services?.length ? { services } : {})
	});
}

export async function unpauseServices(
	ui: UiState,
	project: Pick<ComposeProject, 'id' | 'path'>,
	services?: string[]
) {
	await postProjectAction(ui, project.path, 'unpause', project.id, {
		...(services?.length ? { services } : {})
	});
}

export async function loadProjectServices(
	ui: UiState,
	project: Pick<ComposeProject, 'id' | 'path'>
): Promise<ComposeService[]> {
	const params = new URLSearchParams();
	params.set('all', 'true');

	const response = await fetch(
		`${joinUrl(ui.serverUrl, ui.apiVersion, `/ps/${project.id}`)}?${params.toString()}`,
		{
			headers: {
				accept: 'application/json'
			}
		}
	);

	if (!response.ok) {
		throw new Error(`ps returned ${response.status}`);
	}

	const payload = (await response.json()) as unknown;
	return parseServices(payload).map((service, index) => toService(service, project as ComposeProject, index));
}

export async function startWatching(ui: UiState, project: string, path?: string) {
	const response = await fetch(joinUrl(ui.serverUrl, ui.apiVersion, `/watch/${project}`), {
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		},
		body: JSON.stringify(path ? { path } : {})
	});

	if (!response.ok) {
		throw new Error(`watch returned ${response.status}`);
	}
}

export async function stopWatching(ui: UiState, project: string) {
	const response = await fetch(joinUrl(ui.serverUrl, ui.apiVersion, `/watch/${project}`), {
		method: 'DELETE'
	});

	if (!response.ok) {
		throw new Error(`stop watching returned ${response.status}`);
	}
}
