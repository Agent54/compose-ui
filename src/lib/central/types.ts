export type ApiField = {
	name: string;
	type: string;
	description: string;
	repeated?: boolean;
	values?: string[];
};

export type ApiRoute = {
	method: 'GET' | 'POST' | 'HEAD' | 'DELETE';
	path: string;
	versioned: boolean;
	summary: string;
	queryParams?: ApiField[];
	bodyFields?: ApiField[];
};

export type ApiSchema = {
	versionMatcher: string;
	config: {
		rootDir: string;
		maxDepth: number;
		excludedDirs: string[];
	};
	routes: ApiRoute[];
};

export type ConnectionStatus = 'connecting' | 'connected' | 'error';

export type ComposeProject = {
	id: string;
	name: string;
	path: string;
	state: 'running' | 'exited' | 'uncreated' | 'stopped' | 'paused';
	statusLabel: string;
	containerCount: number;
	watching: boolean;
	expanded: boolean;
	updatedLabel: string;
};

export type ComposeService = {
	id: string;
	projectId: string;
	name: string;
	serviceName: string;
	containerName: string;
	state: 'running' | 'exited' | 'paused' | 'created' | 'unknown';
	stateText: string;
	health?: 'healthy' | 'unhealthy';
};

export type LogEntry = {
	id: string;
	projectId: string;
	level: 'ok' | 'info' | 'warn';
	time: string;
	message: string;
};

export type LocalSettings = {
	id: 'localstorage';
	expandedProjectIds: string[];
};

export type UiState = {
	id: 'app';
	serverUrl: string;
	apiVersion: string;
	filter: string;
	sortBy: 'path' | 'name' | 'status';
	selectedProjectId: string;
	status: ConnectionStatus;
	statusDetail: string;
};
