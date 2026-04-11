import type { ComposeProject, ComposeService, LogEntry, UiState } from './types';

export const initialUiState: UiState[] = [
	{
		id: 'app',
		serverUrl: 'http://127.0.0.1:8080',
		apiVersion: '1',
		filter: '',
		selectedProjectId: 'darc',
		status: 'demo',
		statusDetail: 'Seeded preview until the Compose API is reachable.'
	}
];

export const initialProjects: ComposeProject[] = [
	{
		id: 'agenda',
		name: 'agenda',
		path: './agenda',
		state: 'running',
		watch: false,
		expanded: true,
		updatedLabel: '44 hours ago'
	},
	{
		id: 'darc',
		name: 'darc',
		path: './darc',
		state: 'running',
		watch: true,
		expanded: true,
		updatedLabel: '44 hours ago'
	},
	{
		id: 'data',
		name: 'data',
		path: './data',
		state: 'running',
		watch: false,
		expanded: true,
		updatedLabel: '44 hours ago'
	},
	{
		id: 'dev',
		name: 'dev',
		path: './dev',
		state: 'stopped',
		watch: false,
		expanded: true,
		updatedLabel: '44 hours ago'
	},
	{
		id: 'forgejo',
		name: 'forgejo',
		path: './forgejo',
		state: 'running',
		watch: false,
		expanded: true,
		updatedLabel: '44 hours ago'
	},
	{
		id: 'homepage',
		name: 'homepage',
		path: './homepage',
		state: 'running',
		watch: false,
		expanded: true,
		updatedLabel: '44 hours ago'
	}
];

export const initialServices: ComposeService[] = [
	{
		id: 'agenda-main',
		projectId: 'agenda',
		name: 'agenda-agenda',
		containerName: 'agenda-agenda-1',
		state: 'running',
		stateText: 'Up 44 hours'
	},
	{
		id: 'darc-api',
		projectId: 'darc',
		name: 'darc-api',
		containerName: 'gifted_volhard',
		state: 'exited',
		stateText: 'Exited (137) 2 days ago'
	},
	{
		id: 'darc-worker',
		projectId: 'darc',
		name: 'darc-worker',
		containerName: 'darc-worker-1',
		state: 'running',
		stateText: 'Up 44 hours'
	},
	{
		id: 'darc-orchestrator',
		projectId: 'darc',
		name: 'darc-orchestrator',
		containerName: 'darc-orchestrator-1',
		state: 'running',
		stateText: 'Up 44 hours'
	},
	{
		id: 'data-proxy',
		projectId: 'data',
		name: 'data-mitm-proxy',
		containerName: 'data-mitm-proxy-1',
		state: 'running',
		stateText: 'Up 44 hours',
		health: 'healthy'
	},
	{
		id: 'data-opencode',
		projectId: 'data',
		name: 'data-opencode',
		containerName: 'data-opencode-1',
		state: 'running',
		stateText: 'Up 44 hours',
		health: 'healthy'
	},
	{
		id: 'dev-db',
		projectId: 'dev',
		name: 'dev-tanstackdb',
		containerName: 'dev-tanstackdb-1',
		state: 'exited',
		stateText: 'Exited (0) 44 hours ago'
	},
	{
		id: 'forgejo-main',
		projectId: 'forgejo',
		name: 'codeberg.org/forgejo/forgejo:14',
		containerName: 'forgejo',
		state: 'running',
		stateText: 'Up 44 hours'
	},
	{
		id: 'homepage-main',
		projectId: 'homepage',
		name: 'homepage-homepage',
		containerName: 'homepage-homepage-1',
		state: 'running',
		stateText: 'Up 44 hours'
	}
];

export const initialLogs: LogEntry[] = [
	{
		id: 'log-1',
		projectId: 'darc',
		level: 'ok',
		time: '16:42',
		message: 'watch resource attached for ./darc'
	},
	{
		id: 'log-2',
		projectId: 'darc',
		level: 'info',
		time: '16:44',
		message: 'compose project healthy; 2 running services, 1 exited service'
	},
	{
		id: 'log-3',
		projectId: 'dev',
		level: 'warn',
		time: '16:45',
		message: 'project is currently stopped; use Up to restart with optional watch'
	}
];
