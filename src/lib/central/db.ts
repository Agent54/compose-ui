import { createCollection, localOnlyCollectionOptions, localStorageCollectionOptions } from '@tanstack/db';

import { loadProjectServices } from './api';
import { initialLogs, initialProjects, initialServices, initialUiState } from './sample-data';
import type {
	ComposeProject,
	ComposeService,
	ConnectionStatus,
	LocalSettings,
	LogEntry,
	UiState
} from './types';

type RecordWithId = { id: string };
type SyncWriteMessage<T extends RecordWithId> = { type: 'insert' | 'update' | 'delete'; value: T };

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

function currentServices() {
	return [...servicesCollection.state.values()] as ComposeService[];
}

function currentProjects() {
	return [...projectsCollection.state.values()] as ComposeProject[];
}

let serviceSyncBegin: ((options?: { immediate?: boolean }) => void) | null = null;
let serviceSyncWrite: ((message: SyncWriteMessage<ComposeService>) => void) | null = null;
let serviceSyncCommit: (() => void) | null = null;
let serviceLoadPromise: Promise<void> | null = null;
let serviceLoadSignature = '';
const loadedServicePaths = new Map<string, string>();

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

export const logsCollection = createCollection(
	localOnlyCollectionOptions<LogEntry, string>({
		id: 'compose-logs',
		getKey: (item) => item.id,
		initialData: initialLogs
	})
);

export const settingsCollection = createCollection(
	localStorageCollectionOptions({
		id: 'compose-settings',
		storageKey: 'compose-control-settings',
		getKey: (item: LocalSettings) => item.id
	})
);

function writeServiceSnapshots(snapshots: Array<{ projectId: string; services: ComposeService[] }>) {
	if (!serviceSyncBegin || !serviceSyncWrite || !serviceSyncCommit) {
		return;
	}

	serviceSyncBegin({ immediate: true });

	for (const snapshot of snapshots) {
		const currentProjectServices = currentServices().filter(
			(service) => service.projectId === snapshot.projectId
		);
		const nextIds = new Set(snapshot.services.map((service) => service.id));

		for (const current of currentProjectServices) {
			if (!nextIds.has(current.id)) {
				serviceSyncWrite({ type: 'delete', value: current });
			}
		}

		for (const service of snapshot.services) {
			serviceSyncWrite({
				type: servicesCollection.state.has(service.id) ? 'update' : 'insert',
				value: service
			});
		}
	}

	serviceSyncCommit();
}

function clearServicesForProjects(projectIds: string[]) {
	if (!projectIds.length || !serviceSyncBegin || !serviceSyncWrite || !serviceSyncCommit) {
		return;
	}

	serviceSyncBegin({ immediate: true });

	for (const service of currentServices()) {
		if (projectIds.includes(service.projectId)) {
			serviceSyncWrite({ type: 'delete', value: service });
		}
	}

	serviceSyncCommit();
}

async function syncProjectServices(projectIds?: string[], force = false) {
	const ui = uiStateCollection.state.get('app');

	if (!ui) {
		return;
	}

	const settings = settingsCollection.state.get('localstorage');
	const targetIds = [...new Set(projectIds ?? settings?.expandedProjectIds ?? [])];
	const projects = targetIds
		.map((projectId) => projectsCollection.state.get(projectId))
		.filter(Boolean) as ComposeProject[];

	if (!projects.length) {
		return;
	}

	const signature = projects
		.map((project) => `${project.id}:${project.path}`)
		.sort()
		.join('|');

	if (!force && serviceLoadPromise && serviceLoadSignature === signature) {
		return serviceLoadPromise;
	}

	const projectsToLoad = force
		? projects
		: projects.filter((project) => loadedServicePaths.get(project.id) !== project.path);

	if (!projectsToLoad.length) {
		return;
	}

	const loadPromise = Promise.all(
		projectsToLoad.map(async (project) => ({
			projectId: project.id,
			services: await loadProjectServices(ui, project)
		}))
	).then((snapshots) => {
		writeServiceSnapshots(snapshots);

		for (const project of projectsToLoad) {
			loadedServicePaths.set(project.id, project.path);
		}
	});

	serviceLoadPromise = loadPromise.finally(() => {
		if (serviceLoadPromise === loadPromise) {
			serviceLoadPromise = null;
			serviceLoadSignature = '';
		}
	});
	serviceLoadSignature = signature;

	return serviceLoadPromise;
}

export const servicesCollection = createCollection({
	id: 'compose-services',
	getKey: (item: ComposeService) => item.id,
	syncMode: 'on-demand',
	sync: {
		sync: ({ begin, write, commit, markReady }) => {
			serviceSyncBegin = begin;
			serviceSyncWrite = write as (message: SyncWriteMessage<ComposeService>) => void;
			serviceSyncCommit = commit;

			if (initialServices.length) {
				begin({ immediate: true });

				for (const service of initialServices) {
					write({ type: 'insert', value: service });
				}

				commit();
			}

			markReady();

			return {
				loadSubset: () => syncProjectServices()
			};
		}
	}
});

export function updateUiState(patch: Partial<Omit<UiState, 'id'>>) {
	uiStateCollection.update('app', (draft) => {
		Object.assign(draft, patch);
	});
}

export function selectProject(projectId: string) {
	updateUiState({ selectedProjectId: projectId });
}

export function setProjectExpanded(projectId: string, expanded: boolean) {
	try {
		settingsCollection.update('localstorage', (draft: LocalSettings) => {
			const expandedIds = new Set(draft.expandedProjectIds);

			if (expanded) {
				expandedIds.add(projectId);
			} else {
				expandedIds.delete(projectId);
			}

			draft.expandedProjectIds = [...expandedIds];
		});
	} catch {
		settingsCollection.insert({
			id: 'localstorage',
			expandedProjectIds: expanded ? [projectId] : []
		});
	}

	if (!expanded) {
		loadedServicePaths.delete(projectId);
	}
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
	const nextProjectIds = new Set(projects.map((project) => project.id));
	const removedProjectIds = currentProjects()
		.map((project) => project.id)
		.filter((projectId) => !nextProjectIds.has(projectId));

	for (const projectId of removedProjectIds) {
		projectsCollection.delete(projectId);
		loadedServicePaths.delete(projectId);
	}

	for (const project of projects) {
		upsert(projectsCollection, project);
	}

	clearServicesForProjects(removedProjectIds);

	if (services.length) {
		const serviceSnapshots = [...services.reduce((grouped, service) => {
			const current = grouped.get(service.projectId);

			if (current) {
				current.push(service);
			} else {
				grouped.set(service.projectId, [service]);
			}

			return grouped;
		}, new Map<string, ComposeService[]>())].map(([projectId, projectServices]) => ({
			projectId,
			services: projectServices
		}));
		writeServiceSnapshots(serviceSnapshots);
	}
}

export function invalidateProjectServices(projectId?: string) {
	if (projectId) {
		loadedServicePaths.delete(projectId);
		return;
	}

	loadedServicePaths.clear();
}

export async function reloadProjectServices(projectIds?: string[]) {
	await syncProjectServices(projectIds, true);
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
