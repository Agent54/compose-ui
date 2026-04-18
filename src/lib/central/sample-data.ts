import type { ComposeProject, ComposeService, LogEntry, UiState } from './types';

export const initialUiState: UiState[] = [
	{
		id: 'app',
		serverUrl: 'http://127.0.0.1:8094',
		apiVersion: '1.24',
		filter: '',
		sortBy: 'status',
		autoRefreshPaused: false,
		selectedProjectId: '',
		selectedContainerId: '',
		status: 'connecting',
		statusDetail: 'Connecting to http://127.0.0.1:8094.'
	}
];

export const initialProjects: ComposeProject[] = [];

export const initialServices: ComposeService[] = [];

export const initialLogs: LogEntry[] = [];
