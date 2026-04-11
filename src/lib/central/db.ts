import { createCollection, localOnlyCollectionOptions } from '@tanstack/db';

import { initialLogs, initialProjects, initialServices, initialUiState } from './sample-data';
import type { ComposeProject, ComposeService, ConnectionStatus, LogEntry, UiState } from './types';

type RecordWithId = { id: string };

type WritableCollection<T extends RecordWithId> = {
	insert: (item: T) => void;
	update: (key: string, updater: (draft: T) => void) => void;
};

function upsert<T extends RecordWithId>(collection: WritableCollection<T>, item: T) {
	try {
		collection.update(item.id, (draft) => {
			Object.assign(draft, item);
		});
	} catch {
		collection.insert(item);
	}
}

function stampTime() {
	return new Intl.DateTimeFormat('en-GB', {
		hour: '2-digit',
		minute: '2-digit'
	}).format(new Date());
}

export const uiStateCollection = createCollection(
	localOnlyCollectionOptions<UiState, string>({
		id: 'compose-ui',
		getKey: (item) => item.id,
		initialData: initialUiState
	})
);

export const projectsCollection = createCollection(
	localOnlyCollectionOptions<ComposeProject, string>({
		id: 'compose-projects',
		getKey: (item) => item.id,
		initialData: initialProjects
	})
);

export const servicesCollection = createCollection(
	localOnlyCollectionOptions<ComposeService, string>({
		id: 'compose-services',
		getKey: (item) => item.id,
		initialData: initialServices
	})
);

export const logsCollection = createCollection(
	localOnlyCollectionOptions<LogEntry, string>({
		id: 'compose-logs',
		getKey: (item) => item.id,
		initialData: initialLogs
	})
);

export function updateUiState(patch: Partial<Omit<UiState, 'id'>>) {
	uiStateCollection.update('app', (draft) => {
		Object.assign(draft, patch);
	});
}

export function selectProject(projectId: string) {
	updateUiState({ selectedProjectId: projectId });
}

export function setProjectExpanded(projectId: string, expanded: boolean) {
	projectsCollection.update(projectId, (draft) => {
		draft.expanded = expanded;
	});
}

export function setProjectWatch(projectId: string, watch: boolean) {
	projectsCollection.update(projectId, (draft) => {
		draft.watch = watch;
		draft.updatedLabel = 'just now';
	});
}

export function setProjectState(projectId: string, state: ComposeProject['state']) {
	projectsCollection.update(projectId, (draft) => {
		draft.state = state;
		draft.updatedLabel = 'just now';
	});
}

export function setConnectionState(status: ConnectionStatus, statusDetail: string) {
	updateUiState({ status, statusDetail });
}

export function hydrateProjects(projects: ComposeProject[], services: ComposeService[]) {
	for (const project of projects) {
		upsert(projectsCollection, project);
	}

	for (const service of services) {
		upsert(servicesCollection, service);
	}
}

export function appendLog(projectId: string, level: LogEntry['level'], message: string) {
	logsCollection.insert({
		id: `${projectId}-${Date.now()}-${crypto.randomUUID()}`,
		projectId,
		level,
		time: stampTime(),
		message
	});
}
