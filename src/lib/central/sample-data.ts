import type { ComposeBuild, ComposeProject, ComposeService, LogEntry, UiState } from './types';

export const initialUiState: UiState[] = [
	{
		id: 'app',
		serverUrl: '',
		apiVersion: '1.24',
		filter: '',
		sortBy: 'status',
		autoRefreshPaused: false,
		selectedProjectId: '',
		selectedContainerId: '',
		status: 'connecting',
		statusDetail: 'Connecting to the local Compose service.'
	}
];

export const initialProjects: ComposeProject[] = [];

export const initialServices: ComposeService[] = [];

export const initialBuilds: ComposeBuild[] = [];

export const initialLogs: LogEntry[] = [];
