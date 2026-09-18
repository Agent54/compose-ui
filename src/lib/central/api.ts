import type {
	ComposeBuild,
	ComposeProcessSnapshot,
	ComposeProject,
	ComposeService,
	ProjectResources,
	UiState
} from './types';

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
	configFiles?: string;
	config_files?: string;
	ConfigFile?: string;
	configFile?: string;
	watch?: boolean | string | number;
	Watch?: boolean | string | number;
	watching?: boolean | string | number;
	Watching?: boolean | string | number;
	watchActive?: boolean | string | number;
	WatchActive?: boolean | string | number;
	watch_active?: boolean | string | number;
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
	path?: string;
	composePath?: string;
	configFiles?: string;
	ConfigFiles?: string;
	Labels?: Record<string, string>;
	labels?: Record<string, string>;
};

type RefreshResult = {
	projects: ComposeProject[];
	services: ComposeService[];
};

type UpResponse = {
	ok?: boolean;
	project?: string;
	configFiles?: string;
	buildId?: string;
	buildUrl?: string;
	watching?: boolean;
	watchUrl?: string;
};

type ListedBuild = {
	id?: string;
	project?: string;
	status?: string;
	startedAt?: string;
	finishedAt?: string | null;
	success?: boolean | null;
	streamUrl?: string;
};

type ListedProcessSnapshot = {
	ID?: string;
	Id?: string;
	id?: string;
	Name?: string;
	name?: string;
	Service?: string;
	service?: string;
	Replica?: string;
	replica?: string;
	Titles?: string[];
	titles?: string[];
	Processes?: string[][];
	processes?: string[][];
};

function normalizeVersion(version: string) {
	return version.replace(/^v/i, '') || '1';
}

function joinUrl(serverUrl: string, version: string, path: string) {
	const base = serverUrl.trim().replace(/\/+$/, '');
	return `${base}/v${normalizeVersion(version)}${path}`;
}

export function resolveBuildStreamUrl(ui: Pick<UiState, 'serverUrl' | 'apiVersion'>, streamUrl: string) {
	const trimmed = streamUrl.trim();

	if (!trimmed) {
		return '';
	}

	if (/^https?:\/\//i.test(trimmed)) {
		return trimmed;
	}

	if (/^\/v[0-9.]+\//i.test(trimmed)) {
		return `${ui.serverUrl.trim().replace(/\/+$/, '')}${trimmed}`;
	}

	return joinUrl(ui.serverUrl, ui.apiVersion, trimmed);
}

export function composeLogsStreamUrl(
	ui: Pick<UiState, 'serverUrl' | 'apiVersion'>,
	project: string,
	options?: {
		path?: string;
		services?: string[];
		follow?: boolean;
		tail?: string;
		since?: string;
		until?: string;
		timestamps?: boolean;
		index?: string;
	}
) {
	const params = new URLSearchParams();

	if (options?.path) {
		params.set('path', options.path);
	}

	for (const service of options?.services ?? []) {
		params.append('service', service);
	}

	if (typeof options?.follow === 'boolean') {
		params.set('follow', String(options.follow));
	}

	if (options?.tail) {
		params.set('tail', options.tail);
	}

	if (options?.since) {
		params.set('since', options.since);
	}

	if (options?.until) {
		params.set('until', options.until);
	}

	if (typeof options?.timestamps === 'boolean') {
		params.set('timestamps', String(options.timestamps));
	}

	if (options?.index) {
		params.set('index', options.index);
	}

	const query = params.toString();
	const path = `/logs/${encodeURIComponent(project)}`;

	return `${joinUrl(ui.serverUrl, ui.apiVersion, path)}${query ? `?${query}` : ''}`;
}

function summarizeErrorPayload(payload: unknown): string {
	if (typeof payload === 'string') {
		return payload.trim();
	}

	if (!payload || typeof payload !== 'object') {
		return '';
	}

	const objectPayload = payload as Record<string, unknown>;

	for (const key of ['message', 'error', 'detail', 'reason']) {
		const value = objectPayload[key];

		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}

	return '';
}

async function responseError(action: string, response: Response): Promise<Error> {
	let detail = '';

	try {
		const text = (await response.text()).trim();

		if (text) {
			try {
				detail = summarizeErrorPayload(JSON.parse(text)) || text;
			} catch {
				detail = text;
			}
		}
	} catch {
		detail = '';
	}

	const statusSuffix = response.statusText ? ` ${response.statusText}` : '';
	const baseMessage = `${action} failed (${response.status}${statusSuffix})`;

	return new Error(detail ? `${baseMessage}: ${detail}` : baseMessage);
}

function normalizeListedState(rawState: string, rawStatus: string) {
	const state = rawState.trim().toLowerCase();
	const status = rawStatus.trim().toLowerCase();

	if (state === 'paused' || status.includes('paused')) {
		return 'paused' as const;
	}

	if (state === 'running' || status === 'up' || status.startsWith('up ')) {
		return 'running' as const;
	}

	if (state === 'exited' || state === 'dead' || status.startsWith('exited')) {
		return 'exited' as const;
	}

	if (state === 'stopped' || state === 'stop' || status === 'stopped' || status.startsWith('stopped')) {
		return 'stopped' as const;
	}

	if (state === 'created') {
		return 'created' as const;
	}

	if (state === 'uncreated' || status === 'uncreated') {
		return 'uncreated' as const;
	}

	return 'unknown' as const;
}

function isTruthyFlag(value: unknown) {
	if (value === true || value === 1) {
		return true;
	}

	if (typeof value === 'string') {
		return ['1', 'true', 'yes', 'on', 'watching', 'active'].includes(value.trim().toLowerCase());
	}

	return false;
}

function toProject(raw: ListedProject, index: number): ComposeProject {
	const name = raw.Name ?? raw.name ?? raw.project ?? raw.ID ?? raw.id ?? `project-${index + 1}`;
	const sourceId = raw.ID ?? raw.id ?? name;
	const id = String(sourceId).trim() || `project-${index + 1}`;
	const rawStatus = String(raw.Status ?? raw.status ?? raw.state ?? '').trim();
	const statusMatch = /^([a-z-]+)(?:\((\d+)\))?$/i.exec(rawStatus);
	const statusName = statusMatch?.[1] ?? '';
	const containerCount = Number(statusMatch?.[2] ?? 0);
	const normalizedState =
		raw.running === true || raw.active === true
			? 'running'
			: normalizeListedState(String(raw.state ?? statusName), rawStatus);

	return {
		id,
		name,
		path:
			raw.ConfigFiles ??
			raw.configFiles ??
			raw.config_files ??
			raw.ConfigFile ??
			raw.configFile ??
			raw.path ??
			raw.dir ??
			raw.directory ??
			`./${name}`,
		state:
			normalizedState === 'running' ||
			normalizedState === 'paused' ||
			normalizedState === 'exited' ||
			normalizedState === 'uncreated' ||
			normalizedState === 'stopped'
				? normalizedState
				: 'stopped',
		statusLabel: rawStatus || 'unknown',
		containerCount,
		watching:
			isTruthyFlag(raw.watch) ||
			isTruthyFlag(raw.Watch) ||
			isTruthyFlag(raw.watching) ||
			isTruthyFlag(raw.Watching) ||
			isTruthyFlag(raw.watchActive) ||
			isTruthyFlag(raw.WatchActive) ||
			isTruthyFlag(raw.watch_active),
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

function firstNonEmptyString(...values: unknown[]) {
	for (const value of values) {
		const normalized = String(value ?? '').trim();

		if (normalized) {
			return normalized;
		}
	}

	return '';
}

function parseServiceState(rawState: string, rawStatus: string): ComposeService['state'] {
	const normalized = normalizeListedState(rawState, rawStatus);
	return normalized === 'stopped' ? 'exited' : normalized;
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

function stripHealthSuffix(statusText: string) {
	return statusText
		.replace(/\s*\((healthy|unhealthy)\)\s*$/i, '')
		.trim();
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

function parseComposePath(raw: ListedContainer) {
	const directPath = firstNonEmptyString(
		raw.composePath,
		raw.configFiles,
		raw.ConfigFiles,
		raw.path
	);

	if (directPath) {
		return directPath;
	}

	const labels = raw.Labels ?? raw.labels;

	if (!labels || typeof labels !== 'object') {
		return undefined;
	}

	const composePath = labels['com.docker.compose.project.config_files']?.trim();
	return composePath || undefined;
}

function parseReplica(raw: ListedContainer) {
	const labels = raw.Labels ?? raw.labels;
	const replica = labels?.['com.docker.compose.container-number']?.trim();
	return replica || undefined;
}

export function composeServiceUrl(
	service: Pick<ComposeService, 'serviceName' | 'projectName' | 'replica'>
) {
	const serviceName = service.serviceName.trim().toLowerCase();
	const projectName = service.projectName.trim().toLowerCase();
	const replica = Number(service.replica);
	const replicaSuffix = Number.isInteger(replica) && replica > 1 ? `_${replica}` : '';

	return `http://${serviceName}_${projectName}${replicaSuffix}.localhost:5196/`;
}

function toService(raw: ListedContainer, project: ComposeProject, index: number): ComposeService {
	const serviceName = firstNonEmptyString(
		raw.Service,
		raw.service,
		raw.Name,
		raw.name,
		`service-${index + 1}`
	);
	const containerName = parseContainerName(
		raw,
		firstNonEmptyString(raw.Name, raw.name, serviceName)
	);
	const containerId = firstNonEmptyString(
		raw.ID,
		raw.Id,
		raw.id,
		containerName,
		`${project.id}-${serviceName}-${index + 1}`
	);
	const rawState = String(raw.State ?? raw.state ?? '').trim();
	const rawStatus = String(raw.Status ?? raw.status ?? rawState).trim();

	return {
		id: `${project.id}:${containerId}`,
		projectId: project.id,
		projectName: firstNonEmptyString(raw.Project, raw.project, project.name, project.id),
		name: serviceName,
		serviceName,
		containerName,
		replica: parseReplica(raw),
		composePath: parseComposePath(raw),
		state: parseServiceState(rawState, rawStatus),
		stateText: stripHealthSuffix(rawStatus || rawState || 'unknown'),
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

function parseProcessSnapshots(payload: unknown) {
	if (Array.isArray(payload)) {
		return payload as ListedProcessSnapshot[];
	}

	if (payload && typeof payload === 'object') {
		const objectPayload = payload as { containers?: unknown; items?: unknown; processes?: unknown };

		if (Array.isArray(objectPayload.containers)) {
			return objectPayload.containers as ListedProcessSnapshot[];
		}

		if (Array.isArray(objectPayload.items)) {
			return objectPayload.items as ListedProcessSnapshot[];
		}

		if (Array.isArray(objectPayload.processes)) {
			return objectPayload.processes as ListedProcessSnapshot[];
		}
	}

	return [];
}

function parseBuilds(payload: unknown) {
	if (Array.isArray(payload)) {
		return payload as ListedBuild[];
	}

	if (payload && typeof payload === 'object') {
		const objectPayload = payload as { builds?: unknown; items?: unknown };

		if (Array.isArray(objectPayload.builds)) {
			return objectPayload.builds as ListedBuild[];
		}

		if (Array.isArray(objectPayload.items)) {
			return objectPayload.items as ListedBuild[];
		}
	}

	return [];
}

function toBuild(raw: ListedBuild, index: number): ComposeBuild {
	const id = String(raw.id ?? index + 1).trim();
	const projectName = String(raw.project ?? '').trim() || `project-${index + 1}`;

	return {
		id,
		projectId: projectName,
		projectName,
		kind: 'build',
		status:
			raw.success === false
				? 'failed'
				: raw.success === true
					? 'succeeded'
					: raw.status === 'succeeded' || raw.status === 'failed' || raw.status === 'running'
						? raw.status
						: 'running',
		startedAt: String(raw.startedAt ?? ''),
		serverStartedAt: String(raw.startedAt ?? ''),
		finishedAt: raw.finishedAt ?? null,
		success: typeof raw.success === 'boolean' ? raw.success : null,
		streamUrl: String(raw.streamUrl ?? '').trim() || `/builds/${encodeURIComponent(id)}/stream`
	};
}

function toProcessSnapshot(
	raw: ListedProcessSnapshot,
	project: Pick<ComposeProject, 'id'>
): ComposeProcessSnapshot {
	const containerId = String(raw.ID ?? raw.Id ?? raw.id ?? crypto.randomUUID());
	const containerName = String(raw.Name ?? raw.name ?? '');

	return {
		id: `${project.id}:${containerId}`,
		projectId: project.id,
		containerId,
		containerName,
		serviceName: String(raw.Service ?? raw.service ?? containerName),
		replica: raw.Replica ?? raw.replica,
		titles: Array.isArray(raw.Titles ?? raw.titles) ? [...(raw.Titles ?? raw.titles ?? [])] : [],
		processes: Array.isArray(raw.Processes ?? raw.processes) ? [...(raw.Processes ?? raw.processes ?? [])] : []
	};
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
		throw await responseError('Listing projects', response);
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
		throw await responseError('Checking /_ping', response);
	}
}

export async function startProject(
	ui: UiState,
	path: string,
	watching: boolean,
	services?: string[],
	build = true,
	options?: {
		forceRecreate?: boolean;
	}
) {
	const response = await fetch(joinUrl(ui.serverUrl, ui.apiVersion, '/up'), {
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		},
		body: JSON.stringify({
			path,
			build,
			watch: watching,
			removeOrphans: true,
			...(options?.forceRecreate ? { forceRecreate: true } : {}),
			...(services?.length ? { services } : {})
		})
	});

	if (!response.ok) {
		throw await responseError('Starting project via /up', response);
	}

	const payload = ((await response.json()) as UpResponse | null) ?? {};

	return {
		buildId: payload.buildId?.trim() || undefined,
		buildUrl: payload.buildUrl?.trim() || undefined,
		watching: payload.watching,
		watchUrl: payload.watchUrl?.trim() || undefined
	};
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
		throw await responseError(`Running /${endpoint} for ${projectId}`, response);
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
		removeOrphans: true,
		...(services?.length ? { services } : {})
	});
}

export async function removeServices(
	ui: UiState,
	project: Pick<ComposeProject, 'id' | 'path'>,
	services?: string[]
) {
	await postProjectAction(ui, project.path, 'rm', project.id, {
		force: true,
		stop: true,
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
		throw await responseError(`Loading /ps for ${project.id}`, response);
	}

	const payload = (await response.json()) as unknown;
	return [
		...new Map(
			parseServices(payload)
				.map((service, index) => toService(service, project as ComposeProject, index))
				.map((service) => [service.id, service] as const)
		).values()
	];
}

export async function loadBuilds(ui: UiState): Promise<ComposeBuild[]> {
	const response = await fetch(joinUrl(ui.serverUrl, ui.apiVersion, '/builds'), {
		headers: {
			accept: 'application/json'
		}
	});

	if (!response.ok) {
		throw await responseError('Loading /builds', response);
	}

	const payload = (await response.json()) as unknown;
	return parseBuilds(payload).map(toBuild);
}

export async function loadSystemInfo(ui: UiState): Promise<Record<string, unknown>> {
	const response = await fetch(joinUrl(ui.serverUrl, ui.apiVersion, '/system'), {
		headers: {
			accept: 'application/json'
		}
	});

	if (!response.ok) {
		throw await responseError('Loading /system', response);
	}

	return ((await response.json()) as Record<string, unknown> | null) ?? {};
}

export async function loadSystemDiskUsage(ui: UiState): Promise<Record<string, unknown>> {
	const response = await fetch(joinUrl(ui.serverUrl, ui.apiVersion, '/system/df'), {
		headers: {
			accept: 'application/json'
		}
	});

	if (!response.ok) {
		throw await responseError('Loading /system/df', response);
	}

	return ((await response.json()) as Record<string, unknown> | null) ?? {};
}

export async function loadProjectResources(
	ui: UiState,
	project: Pick<ComposeProject, 'name' | 'id' | 'path'>,
	options?: {
		path?: string;
		services?: string[];
		all?: boolean;
		granularity?: 'all' | 'container' | 'service' | 'project';
	}
): Promise<ProjectResources> {
	const params = new URLSearchParams();

	if (options?.path) {
		params.set('path', options.path);
	}

	for (const service of options?.services ?? []) {
		params.append('service', service);
	}

	if (typeof options?.all === 'boolean') {
		params.set('all', String(options.all));
	}

	if (options?.granularity) {
		params.set('granularity', options.granularity);
	}

	const query = params.toString();
	const projectName = project.name || project.id;
	const response = await fetch(
		`${joinUrl(ui.serverUrl, ui.apiVersion, `/resources/${encodeURIComponent(projectName)}`)}${query ? `?${query}` : ''}`,
		{
			headers: {
				accept: 'application/json'
			}
		}
	);

	if (!response.ok) {
		throw await responseError(`Loading /resources for ${projectName}`, response);
	}

	return ((await response.json()) as ProjectResources | null) ?? {
		project: projectName,
		granularity: options?.granularity ?? 'all'
	};
}

export async function executeProjectCommand(
	ui: UiState,
	project: Pick<ComposeProject, 'name' | 'id'>,
	body: {
		path?: string;
		container?: string;
		service?: string;
		index?: number;
		command?: string[];
		shell?: string;
		shellExecutable?: string;
		workingDir?: string;
		user?: string;
		env?: string[];
		privileged?: boolean;
		tty?: boolean;
		startStopped?: boolean;
	}
) {
	const projectName = project.name || project.id;
	const response = await fetch(joinUrl(ui.serverUrl, ui.apiVersion, `/exec/${encodeURIComponent(projectName)}`), {
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		},
		body: JSON.stringify(body)
	});

	if (!response.ok) {
		throw await responseError(`Starting /exec for ${projectName}`, response);
	}

	return ((await response.json()) as Record<string, unknown> | null) ?? {};
}

export async function killProjectProcess(
	ui: UiState,
	project: Pick<ComposeProject, 'name' | 'id'>,
	body: {
		path?: string;
		container?: string;
		service?: string;
		index?: number;
		pid: number;
		signal?: string;
		hard?: boolean;
	}
) {
	const projectName = project.name || project.id;
	const response = await fetch(
		joinUrl(ui.serverUrl, ui.apiVersion, `/top/${encodeURIComponent(projectName)}/kill`),
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json'
			},
			body: JSON.stringify(body)
		}
	);

	if (!response.ok) {
		throw await responseError(`Killing process for ${projectName}`, response);
	}

	return ((await response.json()) as Record<string, unknown> | null) ?? {};
}

export async function loadProjectConfig(
	ui: UiState,
	projectId: string,
	path: string,
	format: 'yaml' | 'json' = 'yaml'
) {
	const params = new URLSearchParams();
	params.set('path', path);
	params.set('format', format);

	const response = await fetch(
		`${joinUrl(ui.serverUrl, ui.apiVersion, `/config/${projectId}`)}?${params.toString()}`,
		{
			headers: {
				accept: format === 'json' ? 'application/json' : 'application/yaml, text/yaml, text/plain'
			}
		}
	);

	if (!response.ok) {
		throw await responseError(`Loading /config for ${projectId}`, response);
	}

	return await response.text();
}

export async function loadProjectProcesses(
	ui: UiState,
	project: Pick<ComposeProject, 'id'>
): Promise<ComposeProcessSnapshot[]> {
	const params = new URLSearchParams();
	params.set('all', 'true');

	const response = await fetch(
		`${joinUrl(ui.serverUrl, ui.apiVersion, `/top/${project.id}`)}?${params.toString()}`,
		{
			headers: {
				accept: 'application/json'
			}
		}
	);

	if (!response.ok) {
		throw await responseError(`Loading /top for ${project.id}`, response);
	}

	const payload = (await response.json()) as unknown;
	return parseProcessSnapshots(payload).map((entry) => toProcessSnapshot(entry, project));
}
