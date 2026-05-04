<script lang="ts">
	import { eq } from '@tanstack/db';
	import { useLiveQuery } from '@tanstack/svelte-db';
	import { onMount, tick } from 'svelte';

	import Icon from '$lib/components/Icon.svelte';
	import ProjectServicesList from '$lib/components/ProjectServicesList.svelte';
	import {
		appendLog,
		buildsCollection,
		checkHealth,
		type ComposeBuild,
		loadProjectConfig,
		loadBuilds,
		loadProjectProcesses,
		type ComposeProcessSnapshot,
		type ComposeProject,
		type ComposeService,
		type LocalSettings,
		type LogEntry,
		type UiState,
		hydrateBuilds,
		hydrateProjects,
		invalidateProjectServices,
		logsCollection,
		pauseServices,
		projectsCollection,
		refreshProjectsFromServer,
		resolveBuildStreamUrl,
		reloadProjectServices,
		selectContainer,
		selectProject,
		settingsCollection,
		servicesCollection,
		setConnectionState,
		setProjectExpanded,
		setSidebarWidth,
		setProjectWatching,
		stopServices,
		startProject,
		startWatching,
		stopWatching,
		uiStateCollection,
		unpauseServices,
		updateUiState
	} from '$lib/central';

	type ProcessField = {
		label: string;
		value: string;
	};

	type ParsedCommand = {
		raw: string;
		commandName: string;
		commandPath: string;
		argString: string;
	};

	type ContextMenuItem = {
		label: string;
		action: () => void;
		disabled?: boolean;
	};

	type ContextMenuState = {
		x: number;
		y: number;
		items: ContextMenuItem[];
	};

	type ActiveBuildTarget = {
		projectId: string;
		serviceId?: string;
	};

	type BuildStreamEntry = {
		id: string;
		buildId: string;
		projectId: string;
		time: string;
		source: string;
		stream: string;
		message: string;
	};

	type ConfigPanelState = {
		open: boolean;
		loading: boolean;
		error: string;
		content: string;
	};

	const DEFAULT_SIDEBAR_WIDTH = 352;
	const MIN_SIDEBAR_WIDTH = 248;
	const MIN_PANEL_WIDTH = 320;
	const MAX_SIDEBAR_WIDTH = 560;

	let serviceQueryEpoch = $state(0);
	let searchExpanded = $state(false);
	let searchInput: HTMLInputElement | null = null;
	let dragSidebarWidth = $state<number | null>(null);
	let activeBuildTargets = $state<Record<string, ActiveBuildTarget>>({});
	let buildStreamEntries = $state<BuildStreamEntry[]>([]);
	let configPanels = $state<Record<string, ConfigPanelState>>({});
	const buildEventSources = new Map<string, EventSource>();

	const uiQuery = useLiveQuery((q) => q.from({ ui: uiStateCollection }));
	const projectsQuery = useLiveQuery((q) => q.from({ projects: projectsCollection }));
	const settingsQuery = useLiveQuery((q) => q.from({ settings: settingsCollection }));
	const buildsQuery = useLiveQuery((q) => q.from({ builds: buildsCollection }));
	const allLogsQuery = useLiveQuery((q) => q.from({ logs: logsCollection }));

	const uiState = $derived((uiQuery.data?.[0] as UiState | undefined) ?? undefined);
	const selectedProjectId = $derived(uiState?.selectedProjectId ?? '');
	const selectedContainerId = $derived(uiState?.selectedContainerId ?? '');
	const autoRefreshPaused = $derived(uiState?.autoRefreshPaused ?? false);
	const hasFilter = $derived((uiState?.filter ?? '').trim().length > 0);
	const searchOpen = $derived(searchExpanded || hasFilter);
	const settings = $derived((settingsQuery.data?.[0] as LocalSettings | undefined) ?? undefined);
	const expandedProjectIdList = $derived((settings?.expandedProjectIds ?? []).slice().sort());
	const expandedProjectIds = $derived(new Set(expandedProjectIdList));
	const sidebarWidth = $derived(dragSidebarWidth ?? settings?.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH);
	const builds = $derived.by((): ComposeBuild[] => {
		const entries = [...((buildsQuery.data ?? []) as ComposeBuild[])];
		return entries.sort((left, right) => {
			const leftTime = Date.parse(left.startedAt || '') || 0;
			const rightTime = Date.parse(right.startedAt || '') || 0;
			return rightTime - leftTime;
		});
	});

	const allLogs = $derived((allLogsQuery.data ?? []) as LogEntry[]);

	function stateRank(state: ComposeProject['state'] | ComposeService['state'] | 'mixed') {
		if (state === 'running') return 0;
		if (state === 'paused') return 1;
		if (state === 'mixed') return 2;
		if (state === 'exited' || state === 'stopped') return 3;
		if (state === 'created' || state === 'unknown') return 4;
		if (state === 'uncreated') return 5;
		return 6;
	}

	function compareProjects(
		left: ComposeProject,
		right: ComposeProject,
		sortBy: UiState['sortBy']
	) {
		if (sortBy === 'path') {
			return left.path.localeCompare(right.path) || left.name.localeCompare(right.name);
		}

		if (sortBy === 'name') {
			return left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
		}

		const leftState = projectAggregateState(left);
		const rightState = projectAggregateState(right);

		return (
			stateRank(leftState) - stateRank(rightState) ||
			right.containerCount - left.containerCount ||
			left.name.localeCompare(right.name)
		);
	}

	const projects = $derived.by((): ComposeProject[] => {
		const entries = [...((projectsQuery.data ?? []) as ComposeProject[])];
		return entries.sort((left, right) => compareProjects(left, right, uiState?.sortBy ?? 'status'));
	});

	const visibleProjects = $derived.by(() => {
		const filter = uiState?.filter.trim().toLowerCase() ?? '';

		if (!filter) {
			return projects;
		}

		return projects.filter(
			(project) =>
				project.name.toLowerCase().includes(filter) || project.path.toLowerCase().includes(filter)
		);
	});

	const selectedProject = $derived.by(
		() => visibleProjects.find((project) => project.id === selectedProjectId) ?? visibleProjects[0]
	);
	const selectedProjectServicesQuery = useLiveQuery(
		(q) =>
			q
				.from({ services: servicesCollection })
				.where(({ services }) => eq(services.projectId, selectedProjectId || '__none__'))
				.orderBy(({ services }) => services.serviceName)
				.orderBy(({ services }) => services.containerName),
		[() => selectedProjectId, () => serviceQueryEpoch]
	);

	const selectedServices = $derived(
		(selectedProjectServicesQuery.data ?? []) as ComposeService[]
	);
	const selectedContainer = $derived(
		selectedContainerId
			? selectedServices.find((service) => service.id === selectedContainerId)
			: undefined
	);
	const selectedProjectBuilds = $derived(
		selectedProject
			? builds.filter(
					(build) =>
						build.projectId === selectedProject.id || build.projectName === selectedProject.name
				)
			: []
	);
	const selectedBuildEntries = $derived(
		selectedProject
			? buildStreamEntries.filter((entry) => entry.projectId === selectedProject.id).slice().reverse()
			: []
	);
	const selectedLogs = $derived(
		selectedProject ? allLogs.filter((entry) => entry.projectId === selectedProject.id).slice().reverse() : []
	);
	let refreshing = $state(false);
	let busyAction = $state<string | null>(null);
	let topLoading = $state(false);
	let topError = $state('');
	let processSnapshots = $state<ComposeProcessSnapshot[]>([]);
	let contextMenu = $state<ContextMenuState | null>(null);
	const ACTION_SETTLE_ATTEMPTS = 8;
	const ACTION_SETTLE_DELAY_MS = 350;
	const LS_POLL_INTERVAL_MS = 5000;

	$effect(() => {
		if (!visibleProjects.length) {
			if (selectedProjectId) {
				selectProject('');
			}

			return;
		}

		const exists = visibleProjects.some((project) => project.id === selectedProjectId);

		if (!selectedProjectId || !exists) {
			selectProject(visibleProjects[0].id);
		}
	});

	$effect(() => {
		if (!selectedContainerId) {
			return;
		}

		if (!selectedProjectServicesQuery.isReady) {
			return;
		}

		if (!selectedContainer || selectedContainer.projectId !== selectedProjectId) {
			updateUiState({ selectedContainerId: '' });
		}
	});

	function toggleAutoRefresh() {
		updateUiState({ autoRefreshPaused: !autoRefreshPaused });
	}

	function handleManualRefresh() {
		void refresh({ silent: true });
	}

	async function openSearch(event?: MouseEvent) {
		if (searchOpen) {
			event?.preventDefault();
			searchInput?.focus();
			return;
		}

		event?.preventDefault();
		searchExpanded = true;
		await tick();
		searchInput?.focus();
	}

	function collapseSearch() {
		if (!hasFilter) {
			searchExpanded = false;
		}
	}

	function clampSidebarWidth(width: number) {
		const viewportMax =
			typeof window === 'undefined'
				? MAX_SIDEBAR_WIDTH
				: Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - MIN_PANEL_WIDTH));

		return Math.max(MIN_SIDEBAR_WIDTH, Math.min(viewportMax, Math.round(width)));
	}

	function startSidebarResize(event: MouseEvent) {
		if (!isPrimaryMouse(event) || typeof window === 'undefined' || window.innerWidth <= 700) {
			return;
		}

		event.preventDefault();
		contextMenu = null;

		const initialWidth = sidebarWidth;
		dragSidebarWidth = initialWidth;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		const handleMove = (moveEvent: MouseEvent) => {
			dragSidebarWidth = clampSidebarWidth(moveEvent.clientX);
		};

		const handleUp = () => {
			window.removeEventListener('mousemove', handleMove);
			window.removeEventListener('mouseup', handleUp);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';

			const settledWidth = clampSidebarWidth(dragSidebarWidth ?? initialWidth);
			dragSidebarWidth = null;
			setSidebarWidth(settledWidth);
		};

		window.addEventListener('mousemove', handleMove);
		window.addEventListener('mouseup', handleUp, { once: true });
	}

	function statusLineText() {
		const base = uiState?.statusDetail ?? 'Status unavailable.';
		return `${base} ${autoRefreshPaused ? 'Polling paused.' : 'Polling every 5s.'}`;
	}

	function statusTooltipText() {
		return `${statusLineText()} ${autoRefreshPaused ? 'Click to resume polling.' : 'Click to pause polling.'}`;
	}

	function formatBuildTime(value: string | null) {
		if (!value) {
			return '';
		}

		const date = new Date(value);

		if (Number.isNaN(date.getTime())) {
			return '';
		}

		return new Intl.DateTimeFormat('en-GB', {
			hour: '2-digit',
			minute: '2-digit'
		}).format(date);
	}

	function buildStateChipClass(build: ComposeBuild) {
		if (build.status === 'running') {
			return 'state-chip-running';
		}

		return build.status === 'succeeded' ? 'state-chip-running' : 'state-chip-exited';
	}

	function buildStatusLabel(build: ComposeBuild) {
		if (build.status === 'running') {
			return 'building';
		}

		return build.status === 'succeeded' ? 'succeeded' : 'failed';
	}

	function buildRowTitle(build: ComposeBuild) {
		return build.projectName ? `${build.projectName} build #${build.id}` : `Build #${build.id}`;
	}

	function composeFilePaths(project: ComposeProject | undefined) {
		if (!project?.path) {
			return [];
		}

		return [...new Set(project.path.split(',').map((entry) => entry.trim()).filter(Boolean))];
	}

	function composeFileKey(projectId: string, filePath: string) {
		return `${projectId}:${filePath}`;
	}

	function composeFileName(filePath: string) {
		const parts = filePath.split('/').filter(Boolean);
		return parts.at(-1) ?? filePath;
	}

	function composePanelState(projectId: string, filePath: string): ConfigPanelState {
		return (
			configPanels[composeFileKey(projectId, filePath)] ?? {
				open: false,
				loading: false,
				error: '',
				content: ''
			}
		);
	}

	async function toggleComposeConfig(project: ComposeProject, filePath: string) {
		if (!uiState) {
			return;
		}

		const key = composeFileKey(project.id, filePath);
		const current = composePanelState(project.id, filePath);

		if (current.open) {
			configPanels = {
				...configPanels,
				[key]: {
					...current,
					open: false
				}
			};
			return;
		}

		configPanels = {
			...configPanels,
			[key]: {
				...current,
				open: true,
				loading: !current.content && !current.error
			}
		};

		if (current.content || current.error) {
			return;
		}

		try {
			const content = await loadProjectConfig(uiState, project.id, filePath, 'yaml');
			configPanels = {
				...configPanels,
				[key]: {
					open: true,
					loading: false,
					error: '',
					content
				}
			};
		} catch (error) {
			configPanels = {
				...configPanels,
				[key]: {
					open: true,
					loading: false,
					error: errorMessage(error, `Failed to load config for ${composeFileName(filePath)}.`),
					content: ''
				}
			};
		}
	}

	function setActiveBuildTarget(buildId: string, target: ActiveBuildTarget | null) {
		const nextTargets = { ...activeBuildTargets };

		if (target) {
			nextTargets[buildId] = target;
		} else {
			delete nextTargets[buildId];
		}

		activeBuildTargets = nextTargets;
	}

	function activeBuildTarget(projectId: string) {
		for (const target of Object.values(activeBuildTargets)) {
			if (target.projectId === projectId) {
				return target;
			}
		}

		return null;
	}

	function projectStartButtonSpinning(project: ComposeProject) {
		const target = activeBuildTarget(project.id);
		return (
			Boolean(target && !target.serviceId) ||
			busyAction === `start:${project.id}:project` ||
			busyAction === `up-no-build:${project.id}:project` ||
			busyAction === `restart:${project.id}:project`
		);
	}

	function serviceStartButtonSpinning(project: ComposeProject, service: ComposeService) {
		const target = activeBuildTarget(project.id);
		return (
			Boolean(target && target.serviceId === service.id) ||
			busyAction === `start:${project.id}:${service.id}` ||
			busyAction === `up-no-build:${project.id}:${service.id}` ||
			busyAction === `restart:${project.id}:${service.id}`
		);
	}

	function registerStartedBuild(
		project: ComposeProject,
		startResult: { buildId?: string; buildUrl?: string },
		service?: ComposeService
	) {
		if (!startResult.buildId || !startResult.buildUrl) {
			return;
		}

		const build: ComposeBuild = {
			id: startResult.buildId,
			projectId: project.id,
			projectName: project.name,
			status: 'running',
			startedAt: new Date().toISOString(),
			finishedAt: null,
			success: null,
			streamUrl: startResult.buildUrl
		};

		appendLog(project.id, 'info', `${buildRowTitle(build)} started.`);
		hydrateBuilds([build]);
		setActiveBuildTarget(startResult.buildId, {
			projectId: project.id,
			...(service ? { serviceId: service.id } : {})
		});
		subscribeToBuild(build);
	}

	async function refreshBuildState() {
		if (!uiState) {
			return [] as ComposeBuild[];
		}

		try {
			const nextBuilds = await loadBuilds(uiState);
			hydrateBuilds(nextBuilds);

			const runningIds = new Set(
				nextBuilds.filter((build) => build.status === 'running').map((build) => build.id)
			);

			for (const buildId of Object.keys(activeBuildTargets)) {
				if (!runningIds.has(buildId)) {
					setActiveBuildTarget(buildId, null);
				}
			}

			for (const build of nextBuilds) {
				if (build.status === 'running' && build.streamUrl && !buildEventSources.has(build.id)) {
					subscribeToBuild(build);
				}
			}

			return nextBuilds;
		} catch {
			return [] as ComposeBuild[];
		}
	}

	function closeBuildStream(buildId: string) {
		const source = buildEventSources.get(buildId);

		if (source) {
			source.close();
			buildEventSources.delete(buildId);
		}
	}

	function subscribeToBuild(build: ComposeBuild) {
		if (!uiState || !build.streamUrl || buildEventSources.has(build.id)) {
			return;
		}

		const streamUrl = resolveBuildStreamUrl(uiState, build.streamUrl);

		if (!streamUrl) {
			return;
		}

		const source = new EventSource(streamUrl);
		buildEventSources.set(build.id, source);
		setActiveBuildTarget(build.id, activeBuildTargets[build.id] ?? { projectId: build.projectId });

		source.addEventListener('message', (event) => {
			try {
				const payload = JSON.parse((event as MessageEvent).data) as {
					project?: string;
					stream?: string;
					source?: string;
					message?: string;
					time?: string;
				};
				const projectId = String(payload.project ?? build.projectId).trim() || build.projectId;
				const sourceLabel = String(payload.source ?? '').trim();
				const message = String(payload.message ?? '').trim();

				if (!message) {
					return;
				}

				buildStreamEntries = [
					...buildStreamEntries,
					{
						id: `${build.id}-${Date.now()}-${crypto.randomUUID()}`,
						buildId: build.id,
						projectId,
						time: formatBuildTime(String(payload.time ?? '')) || formatBuildTime(new Date().toISOString()),
						source: sourceLabel || 'Compose',
						stream: String(payload.stream ?? ''),
						message
					}
				];
			} catch {
				// Ignore malformed buffered messages.
			}
		});

		source.onerror = () => {
			void refreshBuildState().then((nextBuilds) => {
				const refreshedBuild = nextBuilds.find((entry) => entry.id === build.id);

				if (!refreshedBuild || refreshedBuild.status !== 'running') {
					closeBuildStream(build.id);
					setActiveBuildTarget(build.id, null);

					if (refreshedBuild) {
						appendLog(
							build.projectId,
							refreshedBuild.status === 'failed' ? 'error' : 'ok',
							`${buildRowTitle(refreshedBuild)} ${refreshedBuild.status === 'failed' ? 'failed' : 'succeeded'}.`
						);
					}
					void refresh({ silent: true });
				}
			});
		};
	}

	onMount(() => {
		void refresh();
		void refreshBuildState();

		const intervalId = window.setInterval(() => {
			const currentUi = uiStateCollection.state.get('app');

			if (!currentUi || currentUi.autoRefreshPaused || refreshing || busyAction) {
				return;
			}

			void refresh({ silent: true });
		}, LS_POLL_INTERVAL_MS);

		return () => {
			window.clearInterval(intervalId);
			for (const source of buildEventSources.values()) {
				source.close();
			}
			buildEventSources.clear();
		};
	});

	$effect(() => {
		const projectId = selectedProjectId;
		const ui = uiState;

		if (!projectId || !ui) {
			processSnapshots = [];
			topError = '';
			topLoading = false;
			return;
		}

		let cancelled = false;
		topLoading = true;
		topError = '';

		void loadProjectProcesses(ui, { id: projectId })
			.then((entries) => {
				if (!cancelled) {
					processSnapshots = entries;
				}
			})
			.catch((error) => {
				if (!cancelled) {
					processSnapshots = [];
					topError = error instanceof Error ? error.message : 'Unable to load processes.';
				}
			})
			.finally(() => {
				if (!cancelled) {
					topLoading = false;
				}
			});

		return () => {
			cancelled = true;
		};
	});

	const visibleProcessSnapshots = $derived(
		selectedContainerId
			? processSnapshots.filter((entry) => entry.id === selectedContainerId)
			: processSnapshots
	);

	function splitShellWords(value: string) {
		const tokens = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
		return tokens.map((token) => token.replace(/^['"]|['"]$/g, ''));
	}

	function parseCommand(raw: string): ParsedCommand | null {
		const normalized = raw.trim();

		if (!normalized) {
			return null;
		}

		const tokens = splitShellWords(normalized);
		const executable = tokens[0] ?? '';

		if (!executable) {
			return null;
		}

		const lastSlash = executable.lastIndexOf('/');
		const commandPath = lastSlash > 0 ? executable.slice(0, lastSlash) : '';
		const commandName = lastSlash >= 0 ? executable.slice(lastSlash + 1) : executable;
		const argString = tokens.slice(1).join(' ');

		return {
			raw: normalized,
			commandName,
			commandPath,
			argString
		};
	}

	function processFields(entry: ComposeProcessSnapshot, process: string[]) {
		return entry.titles.reduce<ProcessField[]>((fields, title, index) => {
			const value = process[index];

			if (!value || title === 'CMD') {
				return fields;
			}

			fields.push({ label: title, value });
			return fields;
		}, []);
	}

	function processCommand(entry: ComposeProcessSnapshot, process: string[]) {
		const commandIndex = entry.titles.indexOf('CMD');

		if (commandIndex < 0) {
			return null;
		}

		return parseCommand(process[commandIndex] ?? '');
	}

	function isProjectFullyPaused(project: ComposeProject) {
		return projectAggregateState(project) === 'paused';
	}

	function projectCanPause(project: ComposeProject) {
		const aggregateState = projectAggregateState(project);
		return aggregateState === 'running' || aggregateState === 'paused' || aggregateState === 'mixed';
	}

	function projectCanStart(project: ComposeProject) {
		const aggregateState = projectAggregateState(project);
		return aggregateState !== 'running' && aggregateState !== 'paused';
	}

	function projectCanStop(project: ComposeProject) {
		const aggregateState = projectAggregateState(project);
		return aggregateState === 'running' || aggregateState === 'paused' || aggregateState === 'mixed';
	}

	function normalizeProjectStatusState(
		value: string
	): ComposeProject['state'] | ComposeService['state'] | 'mixed' {
		const state = value.trim().toLowerCase();

		if (!state) {
			return 'unknown';
		}

		if (state === 'running' || state === 'up') {
			return 'running';
		}

		if (state === 'paused') {
			return 'paused';
		}

		if (state === 'uncreated') {
			return 'uncreated';
		}

		if (state === 'created') {
			return 'created';
		}

		if (state === 'exited' || state === 'dead' || state === 'stopped' || state === 'stop') {
			return 'exited';
		}

		return 'unknown';
	}

	function projectAggregateState(project: ComposeProject) {
		const counts = new Map<string, number>();
		const matches = [...project.statusLabel.toLowerCase().matchAll(/([a-z-]+)(?:\((\d+)\))?/g)];

		for (const match of matches) {
			const normalized = normalizeProjectStatusState(match[1] ?? '');

			if (normalized === 'mixed') {
				continue;
			}

			const amount = Number(match[2] ?? 1) || 1;
			counts.set(normalized, (counts.get(normalized) ?? 0) + amount);
		}

		if (!counts.size) {
			return normalizeProjectStatusState(project.state);
		}

		const nonZeroStates = [...counts.entries()].filter(([, amount]) => amount > 0).map(([state]) => state);

		if (nonZeroStates.length === 1) {
			return nonZeroStates[0] as ComposeProject['state'] | ComposeService['state'];
		}

		return 'mixed';
	}

	function projectRowStatusLabel(project: ComposeProject) {
		const matches = [...project.statusLabel.matchAll(/([a-z-]+)(?:\((\d+)\))?/gi)];

		if (matches.length !== 1) {
			return project.statusLabel;
		}

		const label = matches[0]?.[1]?.trim();
		return label || project.statusLabel;
	}

	function shouldShowProjectRowStatus(project: ComposeProject) {
		const matches = [...project.statusLabel.matchAll(/([a-z-]+)(?:\((\d+)\))?/gi)];

		if (matches.length !== 1) {
			return true;
		}

		const normalized = normalizeProjectStatusState(matches[0]?.[1] ?? '');
		return (
			normalized !== 'running' &&
			normalized !== 'paused' &&
			normalized !== 'exited' &&
			normalized !== 'uncreated'
		);
	}

	function projectRowTooltipText(project: ComposeProject) {
		return `${project.name}\n${project.statusLabel}`;
	}

	function projectIconTone(project: ComposeProject) {
		const aggregateState = projectAggregateState(project);

		if (aggregateState === 'running') {
			return 'project-icon-running';
		}

		if (aggregateState === 'paused') {
			return 'project-icon-paused';
		}

		if (aggregateState === 'uncreated') {
			return 'project-icon-uncreated';
		}

		if (aggregateState === 'created' || aggregateState === 'unknown') {
			return 'project-icon-neutral';
		}

		if (aggregateState === 'mixed') {
			return 'project-icon-warning';
		}

		return 'project-icon-exited';
	}

	function projectStateChipClass(project: ComposeProject | undefined) {
		if (!project) {
			return '';
		}

		const aggregateState = projectAggregateState(project);

		if (aggregateState === 'running') {
			return 'state-chip-running';
		}

		if (aggregateState === 'paused') {
			return 'state-chip-paused';
		}

		if (aggregateState === 'uncreated') {
			return 'state-chip-uncreated';
		}

		if (aggregateState === 'created') {
			return 'state-chip-created';
		}

		if (aggregateState === 'unknown') {
			return 'state-chip-unknown';
		}

		if (aggregateState === 'mixed') {
			return 'state-chip-mixed';
		}

		return 'state-chip-exited';
	}

	function serviceStateTone(service: ComposeService) {
		if (service.state === 'running') {
			return 'service-state-running';
		}

		if (service.state === 'paused') {
			return 'service-state-paused';
		}

		if (service.state === 'uncreated') {
			return 'service-state-uncreated';
		}

		return 'service-state-exited';
	}

	function serviceStateIcon(service: ComposeService) {
		if (service.state === 'uncreated') {
			return 'dotted-circle';
		}

		if (service.state === 'paused') {
			return 'pause';
		}

		if (service.state === 'running') {
			return 'play';
		}

		return 'stop';
	}

	function serviceStateChipClass(service: ComposeService) {
		if (service.state === 'running') {
			return 'state-chip-running';
		}

		if (service.state === 'paused') {
			return 'state-chip-paused';
		}

		if (service.state === 'uncreated') {
			return 'state-chip-uncreated';
		}

		if (service.state === 'created') {
			return 'state-chip-created';
		}

		if (service.state === 'unknown') {
			return 'state-chip-unknown';
		}

		return 'state-chip-exited';
	}

	function errorMessage(error: unknown, fallback: string) {
		if (error instanceof Error && error.message.trim()) {
			return error.message.trim();
		}

		return fallback;
	}

	function wait(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function projectServiceSnapshot(projectId: string, serviceNames?: string[]) {
		return [...servicesCollection.state.values()].filter((service) => {
			if (service.projectId !== projectId) {
				return false;
			}

			if (serviceNames?.length && !serviceNames.includes(service.serviceName)) {
				return false;
			}

			return true;
		}) as ComposeService[];
	}

	function serviceStateMatches(
		service: ComposeService,
		expected: 'running' | 'paused' | 'stopped'
	) {
		if (expected === 'stopped') {
			return service.state !== 'running' && service.state !== 'paused';
		}

		return service.state === expected;
	}

	async function settleProjectServices(
		projectId: string,
		expected: 'running' | 'paused' | 'stopped',
		serviceNames?: string[]
	) {
		for (let attempt = 0; attempt < ACTION_SETTLE_ATTEMPTS; attempt += 1) {
			invalidateProjectServices(projectId);
			await reloadProjectServices([projectId]);
			serviceQueryEpoch += 1;

			const services = projectServiceSnapshot(projectId, serviceNames);

			if (services.length && services.every((service) => serviceStateMatches(service, expected))) {
				return;
			}

			if (attempt < ACTION_SETTLE_ATTEMPTS - 1) {
				await wait(ACTION_SETTLE_DELAY_MS);
			}
		}
	}

	async function refresh(options?: { silent?: boolean }) {
		if (!uiState) {
			return;
		}

		refreshing = true;
		if (!options?.silent) {
			setConnectionState('connecting', 'Connecting to http://127.0.0.1:8094.');
		}

		try {
			await checkHealth(uiState);
			const result = await refreshProjectsFromServer(uiState);
			hydrateProjects(result.projects, result.services);
			invalidateProjectServices();

			if (!options?.silent || uiState.status !== 'connected') {
				setConnectionState('connected', 'Connected and synchronized.');
			}

			if (!options?.silent && selectedProjectId) {
				appendLog(selectedProjectId, 'ok', 'Refreshed project list.');
			}
		} catch (error) {
			const message = errorMessage(error, 'Server unavailable');
			setConnectionState('error', `Unavailable at http://127.0.0.1:8094. ${message}`);

			if (!options?.silent && selectedProjectId) {
				appendLog(selectedProjectId, 'error', `Unavailable. ${message}`);
			}
		} finally {
			refreshing = false;
		}
	}

	async function syncAfterAction(
		project: ComposeProject,
		logMessage: string,
		options?: {
			serviceNames?: string[];
			settleState?: 'running' | 'paused' | 'stopped';
		}
	) {
		await refresh();

		if (options?.settleState) {
			await settleProjectServices(project.id, options.settleState, options.serviceNames);
		} else {
			invalidateProjectServices(project.id);
			await reloadProjectServices([project.id]);
			serviceQueryEpoch += 1;
		}

		appendLog(project.id, 'ok', logMessage);
	}

	async function handleStartStopToggle(project = selectedProject, service?: ComposeService) {
		if (!project || !uiState || busyAction) {
			return;
		}

		const serviceNames = service ? [service.serviceName] : undefined;
		const shouldStop = service
			? service.state === 'running' || service.state === 'paused'
			: projectCanStop(project);
		busyAction = `${shouldStop ? 'stop' : 'start'}:${project.id}:${service?.id ?? 'project'}`;

		try {
			if (shouldStop) {
				await stopServices(uiState, project, serviceNames);
				await syncAfterAction(project, `Stopped ${service?.serviceName ?? project.name}.`, {
					serviceNames,
					settleState: 'stopped'
				});
				setConnectionState('connected', `Stopped ${service?.serviceName ?? project.name}.`);
			} else if (service && service.state === 'uncreated') {
				const startResult = await startProject(
					uiState,
					service.composePath ?? project.path,
					project.watching,
					serviceNames
				);
				registerStartedBuild(project, startResult, service);
				await syncAfterAction(project, `Started ${service.serviceName} in ${project.name} via /up.`, {
					serviceNames,
					settleState: 'running'
				});
				setConnectionState('connected', `Started ${service.serviceName}.`);
			} else if (service) {
				const startResult = await startProject(
					uiState,
					service.composePath ?? project.path,
					project.watching,
					serviceNames,
					true
				);
				registerStartedBuild(project, startResult, service);
				await syncAfterAction(project, `Started ${service.serviceName} in ${project.name} via /up --build.`, {
					serviceNames,
					settleState: 'running'
				});
				setConnectionState('connected', `Started ${service.serviceName}.`);
			} else if (project.state === 'uncreated') {
				const startResult = await startProject(uiState, project.path, project.watching);
				registerStartedBuild(project, startResult);
				await syncAfterAction(project, `Started ${project.name} via /up.`, {
					settleState: 'running'
				});
				setConnectionState('connected', `Started ${project.name}.`);
			} else {
				const startResult = await startProject(uiState, project.path, project.watching, undefined, true);
				registerStartedBuild(project, startResult);
				await syncAfterAction(project, `Started ${project.name} via /up --build.`, {
					settleState: 'running'
				});
				setConnectionState('connected', `Started ${project.name}.`);
			}
		} catch (error) {
			const message = errorMessage(
				error,
				`Failed to ${shouldStop ? 'stop' : 'start'} ${service?.serviceName ?? project.name}.`
			);
			setConnectionState('error', message);
			appendLog(project.id, 'error', message);
		} finally {
			busyAction = null;
		}
	}

	async function handleStartWithoutRebuild(project = selectedProject, service?: ComposeService) {
		if (!project || !uiState || busyAction) {
			return;
		}

		const serviceNames = service ? [service.serviceName] : undefined;
		busyAction = `up-no-build:${project.id}:${service?.id ?? 'project'}`;

		try {
			await startProject(
				uiState,
				service?.composePath ?? project.path,
				project.watching,
				serviceNames,
				false
			);
			await syncAfterAction(
				project,
				`Started ${service?.serviceName ?? project.name} without rebuilding.`,
				{
					serviceNames,
					settleState: 'running'
				}
			);
			setConnectionState(
				'connected',
				`Started ${service?.serviceName ?? project.name} without rebuilding.`
			);
		} catch (error) {
			const message = errorMessage(
				error,
				`Failed to start ${service?.serviceName ?? project.name} without rebuilding.`
			);
			setConnectionState('error', message);
			appendLog(project.id, 'error', message);
		} finally {
			busyAction = null;
		}
	}

	async function handleRestart(project = selectedProject, service?: ComposeService) {
		if (!project || !uiState || busyAction) {
			return;
		}

		const serviceNames = service ? [service.serviceName] : undefined;
		const targetName = service?.serviceName ?? project.name;
		busyAction = `restart:${project.id}:${service?.id ?? 'project'}`;

		try {
			await stopServices(uiState, project, serviceNames);
			const startResult = await startProject(
				uiState,
				service?.composePath ?? project.path,
				project.watching,
				serviceNames,
				true
			);
			registerStartedBuild(project, startResult, service);
			await syncAfterAction(project, `Restarted ${targetName} with rebuild.`, {
				serviceNames,
				settleState: 'running'
			});
			setConnectionState('connected', `Restarted ${targetName}.`);
		} catch (error) {
			const message = errorMessage(error, `Failed to restart ${targetName}.`);
			setConnectionState('error', message);
			appendLog(project.id, 'error', message);
		} finally {
			busyAction = null;
		}
	}

	async function handlePauseToggle(project = selectedProject, service?: ComposeService) {
		if (!project || !uiState || busyAction) {
			return;
		}

		const isUnpause = service ? service.state === 'paused' : isProjectFullyPaused(project);
		const serviceNames = service ? [service.serviceName] : undefined;
		busyAction = `${isUnpause ? 'unpause' : 'pause'}:${project.id}:${service?.id ?? 'project'}`;

		try {
			if (isUnpause) {
				await unpauseServices(uiState, project, serviceNames);
				await syncAfterAction(
					project,
					`Resumed ${service?.serviceName ?? project.name}.`,
					{
						serviceNames,
						settleState: 'running'
					}
				);
				setConnectionState('connected', `Resumed ${service?.serviceName ?? project.name}.`);
			} else {
				await pauseServices(uiState, project, serviceNames);
				await syncAfterAction(
					project,
					`Paused ${service?.serviceName ?? project.name}.`,
					{
						serviceNames,
						settleState: 'paused'
					}
				);
				setConnectionState('connected', `Paused ${service?.serviceName ?? project.name}.`);
			}
		} catch (error) {
			const message = errorMessage(
				error,
				`Failed to ${isUnpause ? 'resume' : 'pause'} ${service?.serviceName ?? project.name}.`
			);
			setConnectionState('error', message);
			appendLog(project.id, 'error', message);
		} finally {
			busyAction = null;
		}
	}

	async function handleWatchingToggle(project = selectedProject) {
		if (!project || !uiState || busyAction) {
			return;
		}

		const nextWatching = !project.watching;
		busyAction = `watching:${project.id}`;

		try {
			if (nextWatching) {
				await startWatching(uiState, project.id, project.path);
				appendLog(project.id, 'ok', `Started watching ${project.name}.`);
			} else {
				await stopWatching(uiState, project.id);
				appendLog(project.id, 'info', `Stopped watching ${project.name}.`);
			}

			setProjectWatching(project.id, nextWatching);
			setConnectionState(
				'connected',
				`${nextWatching ? 'Watching' : 'Stopped watching'} ${project.name}.`
			);
		} catch (error) {
			const message = errorMessage(
				error,
				`${nextWatching ? 'Failed to start watching' : 'Failed to stop watching'} ${project.name}.`
			);
			setConnectionState('error', message);
			appendLog(project.id, 'error', message);
		} finally {
			busyAction = null;
		}
	}

	function handleProjectSelect(projectId: string) {
		contextMenu = null;
		selectProject(projectId);
	}

	function handleContainerSelect(projectId: string, serviceId: string) {
		contextMenu = null;
		selectContainer(projectId, serviceId);
	}

	function isPrimaryMouse(event: MouseEvent) {
		return event.button === 0 && !event.ctrlKey;
	}

	function toggleProject(projectId: string) {
		contextMenu = null;
		setProjectExpanded(projectId, !expandedProjectIds.has(projectId));
	}

	function closeContextMenu() {
		contextMenu = null;
	}

	function canStartWithoutRebuild(project: ComposeProject, service?: ComposeService) {
		if (service) {
			return service.state === 'uncreated';
		}

		return project.state === 'uncreated';
	}

	function buildProjectContextMenuItems(project: ComposeProject): ContextMenuItem[] {
		const canStart = projectCanStart(project);
		const canStop = projectCanStop(project);
		const canPause = projectCanPause(project);
		const canUnpause = isProjectFullyPaused(project);
		const items: ContextMenuItem[] = [];

		if (canStart) {
			items.push({
				label: 'Start',
				action: () => void handleStartStopToggle(project)
			});
		}

		if (canStop) {
			items.push({
				label: 'Stop',
				action: () => void handleStartStopToggle(project)
			});

			items.push({
				label: 'Restart',
				action: () => void handleRestart(project)
			});
		}

		if (canPause && !canUnpause) {
			items.push({
				label: 'Pause',
				action: () => void handlePauseToggle(project)
			});
		}

		if (canUnpause) {
			items.push({
				label: 'Unpause',
				action: () => void handlePauseToggle(project)
			});
		}

		if (!project.watching) {
			items.push({
				label: 'Start watching',
				action: () => void handleWatchingToggle(project)
			});
		}

		if (project.watching) {
			items.push({
				label: 'Stop watching',
				action: () => void handleWatchingToggle(project)
			});
		}

		if (canStartWithoutRebuild(project)) {
			items.push({
				label: 'Start without rebuilding',
				action: () => void handleStartWithoutRebuild(project)
			});
		}

		return items;
	}

	function buildServiceContextMenuItems(
		project: ComposeProject,
		service: ComposeService
	): ContextMenuItem[] {
		const canStart = ['exited', 'created', 'uncreated', 'unknown'].includes(service.state);
		const canStop = service.state === 'running' || service.state === 'paused';
		const canPause = service.state === 'running';
		const canUnpause = service.state === 'paused';
		const items: ContextMenuItem[] = [];

		if (canStart) {
			items.push({
				label: 'Start',
				action: () => void handleStartStopToggle(project, service)
			});
		}

		if (canStop) {
			items.push({
				label: 'Stop',
				action: () => void handleStartStopToggle(project, service)
			});

			items.push({
				label: 'Restart',
				action: () => void handleRestart(project, service)
			});
		}

		if (canPause) {
			items.push({
				label: 'Pause',
				action: () => void handlePauseToggle(project, service)
			});
		}

		if (canUnpause) {
			items.push({
				label: 'Unpause',
				action: () => void handlePauseToggle(project, service)
			});
		}

		if (!project.watching) {
			items.push({
				label: 'Start watching',
				action: () => void handleWatchingToggle(project)
			});
		}

		if (project.watching) {
			items.push({
				label: 'Stop watching',
				action: () => void handleWatchingToggle(project)
			});
		}

		if (canStartWithoutRebuild(project, service)) {
			items.push({
				label: 'Start without rebuilding',
				action: () => void handleStartWithoutRebuild(project, service)
			});
		}

		return items;
	}

	function openProjectContextMenu(event: MouseEvent, project: ComposeProject) {
		event.preventDefault();
		const items = buildProjectContextMenuItems(project);

		contextMenu = items.length
			? {
					x: event.clientX,
					y: event.clientY,
					items
				}
			: null;
	}

	function openServiceContextMenu(
		event: MouseEvent,
		project: ComposeProject,
		service: ComposeService
	) {
		event.preventDefault();
		const items = buildServiceContextMenuItems(project, service);

		contextMenu = items.length
			? {
					x: event.clientX,
					y: event.clientY,
					items
				}
			: null;
	}
</script>

<svelte:head>
	<title>Compose Control</title>
	<meta
		name="description"
		content="Minimal Docker Compose control surface with a compact extension-style shell."
	/>
</svelte:head>

<div class="workspace" style={`--sidebar-width:${sidebarWidth}px;`}>
	<aside class="sidebar">
		<div class="sidebar-controls">
			<label class="sort-menu">
				<Icon name="sort" size={13} />
				<select
					value={uiState?.sortBy ?? 'status'}
					onchange={(event) =>
						updateUiState({
							sortBy: (event.currentTarget as HTMLSelectElement).value as UiState['sortBy']
						})}
					aria-label="Sort projects"
				>
					<option value="status">by status</option>
					<option value="name">by project name</option>
					<option value="path">by compose path</option>
				</select>
			</label>

			<div class:collapsed={!searchOpen} class="search">
				<button
					class="search-trigger"
					type="button"
					aria-label={searchOpen ? 'Focus project filter' : 'Open project filter'}
					onmousedown={(event) => void openSearch(event)}
				>
					<Icon name="search" size={13} />
				</button>
				<input
					bind:this={searchInput}
					type="text"
					value={uiState?.filter ?? ''}
					oninput={(event) =>
						updateUiState({ filter: (event.currentTarget as HTMLInputElement).value })}
					onblur={collapseSearch}
					onkeydown={(event) => {
						if (event.key === 'Escape' && !hasFilter) {
							searchInput?.blur();
						}
					}}
					placeholder="Filter projects"
					aria-label="Filter projects"
				/>
			</div>

			<span class="tooltip-anchor" data-tooltip="Refresh projects">
				<button
					class="refresh-button"
					type="button"
					aria-label="Refresh projects"
					onmousedown={handleManualRefresh}
					disabled={refreshing || busyAction !== null}
				>
					<Icon name="refresh" size={13} spinning={refreshing} />
				</button>
			</span>
		</div>

		<div class="tree" role="tree" aria-label="Compose projects">
			{#if visibleProjects.length}
				{#each visibleProjects as project (project.id)}
					<div class="project-group">
						<div
							class:selected={selectedProject?.id === project.id && !selectedContainerId}
							class="project-row"
							role="treeitem"
							tabindex="-1"
							aria-selected={selectedProject?.id === project.id}
							oncontextmenu={(event) => openProjectContextMenu(event, project)}
						>
							<button
								class="toggle"
								type="button"
								aria-label={expandedProjectIds.has(project.id) ? `Collapse ${project.name}` : `Expand ${project.name}`}
								aria-pressed={expandedProjectIds.has(project.id)}
								onmousedown={(event) => {
									if (!isPrimaryMouse(event)) return;
									toggleProject(project.id);
								}}
							>
								<Icon name="chevron" size={13} rotated={expandedProjectIds.has(project.id)} />
							</button>

							<button
								class="project-button row-tooltip-trigger"
								type="button"
								onmousedown={(event) => {
									if (!isPrimaryMouse(event)) return;
									handleProjectSelect(project.id);
								}}
							>
								<span class="project-copy">
									<span class="project-name">
										<Icon
											name={projectStartButtonSpinning(project) ? 'refresh' : 'container'}
											size={14}
											class={projectIconTone(project)}
											spinning={projectStartButtonSpinning(project)}
										/>
										{project.name}
									</span>
									{#if shouldShowProjectRowStatus(project)}
										<span class="project-status">{projectRowStatusLabel(project)}</span>
									{/if}
								</span>
								<span class="project-meta">
									{#if project.watching}
										<span class="project-watch-indicator" aria-label="Watching">
											<Icon name="eye" size={12} />
										</span>
									{/if}
									{project.containerCount > 0 ? project.containerCount : ''}
								</span>
							</button>
							<span class="row-tooltip-bubble" aria-hidden="true">{projectRowTooltipText(project)}</span>

							<div class="row-actions">
								{#if projectCanStart(project) || projectCanStop(project)}
									<span
										class="tooltip-anchor"
										data-tooltip={`${projectCanStop(project) ? 'Stop' : 'Start'} ${project.name}`}
									>
										<button
											class="overlay-button"
											type="button"
											aria-label={`${projectCanStop(project) ? 'Stop' : 'Start'} ${project.name}`}
											onmousedown={(event) => {
												if (!isPrimaryMouse(event)) return;
												handleStartStopToggle(project);
											}}
											disabled={busyAction !== null}
										>
											<Icon name={projectCanStop(project) ? 'stop' : 'play'} size={13} />
										</button>
									</span>
								{/if}

								{#if projectCanStop(project)}
									<span
										class="tooltip-anchor"
										data-tooltip={`Restart ${project.name}`}
									>
										<button
											class="overlay-button"
											type="button"
											aria-label={`Restart ${project.name}`}
											onmousedown={(event) => {
												if (!isPrimaryMouse(event)) return;
												handleRestart(project);
											}}
											disabled={busyAction !== null}
										>
											<Icon
												name="refresh"
												size={13}
												spinning={busyAction === `restart:${project.id}:project`}
											/>
										</button>
									</span>
								{/if}

								{#if isProjectFullyPaused(project)}
									<span
										class="tooltip-anchor"
										data-tooltip={`Start ${project.name}`}
									>
										<button
											class="overlay-button"
											type="button"
											aria-label={`Start ${project.name}`}
											onmousedown={(event) => {
												if (!isPrimaryMouse(event)) return;
												handlePauseToggle(project);
											}}
											disabled={busyAction !== null}
										>
											<Icon name="play" size={13} />
										</button>
									</span>
								{/if}

								<span
									class="tooltip-anchor"
									data-tooltip={`${project.watching ? 'Stop watching' : 'Watch'} ${project.name}`}
								>
									<button
										class="overlay-button"
										type="button"
										aria-label={`${project.watching ? 'Stop watching' : 'Watch'} ${project.name}`}
										onmousedown={(event) => {
											if (!isPrimaryMouse(event)) return;
											handleWatchingToggle(project);
										}}
										disabled={busyAction !== null}
									>
										<Icon name={project.watching ? 'eye-off' : 'eye'} size={13} />
									</button>
								</span>
							</div>
						</div>

						{#if expandedProjectIds.has(project.id)}
							<ProjectServicesList
								{project}
								{selectedContainerId}
								{busyAction}
								buildingServiceId={activeBuildTarget(project.id)?.serviceId}
								sortBy={uiState?.sortBy ?? 'status'}
								refreshEpoch={serviceQueryEpoch}
								onContainerSelect={handleContainerSelect}
								onStartStop={handleStartStopToggle}
								onRestart={handleRestart}
								onOpenContextMenu={openServiceContextMenu}
								onPauseToggle={handlePauseToggle}
								onWatchingToggle={handleWatchingToggle}
							/>
						{/if}
					</div>
				{/each}
			{:else}
				<div class="sidebar-empty">No Compose projects available.</div>
			{/if}
		</div>
	</aside>

	<button
		class="sidebar-resizer"
		type="button"
		aria-label="Resize sidebar"
		onmousedown={startSidebarResize}
	></button>

	<main class="panel">
		<header class="panel-header">
			<div class="panel-heading">
				<h2>{selectedProject?.name ?? 'Compose Projects'}</h2>
			</div>
			<button
				class="status-line"
				type="button"
				aria-pressed={autoRefreshPaused}
				aria-label={autoRefreshPaused ? 'Resume Compose polling' : 'Pause Compose polling'}
				data-tooltip={statusTooltipText()}
				onmousedown={toggleAutoRefresh}
			>
				<span
					class:paused-status={autoRefreshPaused}
					class:connected={uiState?.status === 'connected'}
					class:error-state={uiState?.status === 'error'}
					class="status-dot"
				>
					{#if autoRefreshPaused}
						<Icon name="pause" size={10} stroke={2.4} />
					{/if}
				</span>
			</button>
		</header>

		<div class="content-grid">
			<section class="card summary-card">
				<div class="card-header">
					<p class="eyebrow">Project</p>
					<div class="pill-row">
						<span class={`pill ${projectStateChipClass(selectedProject)}`}>
							{selectedProject?.statusLabel ?? 'Unknown'}
						</span>
						<span class:active-pill={selectedProject?.watching} class="pill">
							{selectedProject?.watching ? 'Watching' : 'Not Watching'}
						</span>
					</div>
				</div>

				{#if selectedProject && composeFilePaths(selectedProject).length}
					<div class="config-list">
						{#each composeFilePaths(selectedProject) as filePath (`${selectedProject.id}:${filePath}`)}
							{@const panel = composePanelState(selectedProject.id, filePath)}
							<div class="config-item">
								<button
									class="config-button"
									type="button"
									aria-pressed={panel.open}
									onmousedown={(event) => {
										if (!isPrimaryMouse(event)) return;
										void toggleComposeConfig(selectedProject, filePath);
									}}
								>
									<span class="config-copy">
										<span class="row-title">
											<span class="config-chevron">
												<Icon name="chevron" size={12} rotated={panel.open} />
											</span>
											{filePath}
										</span>
									</span>
								</button>

								{#if panel.open}
									<div class="config-output">
										{#if panel.loading}
											<div class="config-output-state">
												<Icon name="refresh" size={13} spinning={true} />
												Loading parsed config…
											</div>
										{:else if panel.error}
											<div class="config-output-state">{panel.error}</div>
										{:else}
											<pre>{panel.content}</pre>
										{/if}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}

				{#if selectedServices.length}
					<div class="compact-list">
						{#each selectedServices as service (service.id)}
							<div class="compact-row">
								<div>
									<div class="row-title">{service.serviceName}</div>
									<div class="row-subtitle">{service.containerName}</div>
								</div>
								<div class="row-tail">
									<span class={`state-chip ${serviceStateChipClass(service)}`}>
										{service.state}
									</span>
									<span>{service.stateText}</span>
									{#if service.health}
										<span class="health-tag">({service.health})</span>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{:else}
					<div class="empty-state">
						{selectedProject && expandedProjectIds.has(selectedProject.id)
							? 'No containers returned by /ps for this project.'
							: 'Open a project to load its containers.'}
					</div>
				{/if}
			</section>

			<section class="card process-card">
				<div class="card-header card-header-compact">
					<p class="eyebrow">Processes</p>
				</div>

				{#if topLoading}
					<div class="empty-state">Loading processes…</div>
				{:else if topError}
					<div class="empty-state">Failed to load processes: {topError}</div>
				{:else if visibleProcessSnapshots.length}
					<div class="process-list">
						{#each visibleProcessSnapshots as entry (entry.id)}
							<div class="process-group">
								<div class="process-heading">
									<div class="tooltip-anchor" data-tooltip={entry.containerName}>
										<div class="row-title">{entry.serviceName}</div>
									</div>
									{#if entry.replica}
										<span class="process-replica">#{entry.replica}</span>
									{/if}
								</div>

								<div class="process-cards">
									{#each entry.processes as process, index (`${entry.id}-${index}`)}
										{@const command = processCommand(entry, process)}
										<div class="process-item">
											{#if command}
												<div class="command-card">
													<div class="command-line">
														<span class="command-name">{command.commandName}</span>
														{#if command.argString}
															<span class="command-inline-args">{command.argString}</span>
														{/if}
													</div>

													{#if command.commandPath}
														<div class="command-path" data-tooltip={command.commandPath}>
															{command.commandPath}
														</div>
													{/if}
												</div>
											{/if}

											<div class="process-meta">
												{#each processFields(entry, process) as field}
													<div class="process-meta-item">
														<span class="process-meta-label">{field.label}</span>
														<strong>{field.value}</strong>
													</div>
												{/each}
											</div>
										</div>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				{:else}
					<div class="empty-state">
						{selectedContainer
							? 'No processes returned for the selected container.'
							: 'No processes returned for this project.'}
					</div>
				{/if}
			</section>

			<section class="card build-card">
				<div class="card-header card-header-compact">
					<p class="eyebrow">Build</p>
				</div>

				{#if selectedProjectBuilds.length}
					<div class="build-list">
						{#each selectedProjectBuilds as build (build.id)}
							<div class="build-row">
								<div class="row-title">
									{buildRowTitle(build)}
									{#if build.status === 'running'}
										<Icon name="refresh" size={12} spinning={true} />
									{/if}
								</div>
								<div class="row-tail">
									<span class={`state-chip ${buildStateChipClass(build)}`}>
										{buildStatusLabel(build)}
									</span>
									<span>{formatBuildTime(build.finishedAt ?? build.startedAt)}</span>
								</div>
							</div>
						{/each}
					</div>
				{/if}

				{#if selectedBuildEntries.length}
					<div class="build-stream-list">
						{#each selectedBuildEntries as entry (entry.id)}
							<div class="build-stream-row">
								<span class="log-time">{entry.time}</span>
								<span class="build-stream-source">{entry.source}</span>
								<span class="log-message">{entry.message}</span>
							</div>
						{/each}
					</div>
				{:else if !selectedProjectBuilds.length}
					<div class="empty-state">No build output yet.</div>
				{/if}
			</section>

			<section class="card log-card">
				<div class="card-header card-header-compact">
					<p class="eyebrow">Project activity</p>
				</div>

				{#if selectedLogs.length}
					<div class="log-list">
						{#each selectedLogs as entry (entry.id)}
							<div class="log-row">
								<span class={`log-level log-${entry.level}`}>{entry.level}</span>
								<span class="log-time">{entry.time}</span>
								<span class="log-message">{entry.message}</span>
							</div>
						{/each}
					</div>
				{:else}
					<div class="empty-state">No activity yet.</div>
				{/if}
			</section>
		</div>
	</main>

	{#if contextMenu}
		<button
			class="context-menu-backdrop"
			type="button"
			aria-label="Close context menu"
			onmousedown={closeContextMenu}
			oncontextmenu={closeContextMenu}
		></button>

		<div class="context-menu" style={`left:${contextMenu.x}px;top:${contextMenu.y}px;`}>
			{#each contextMenu.items as item}
				<button
					class="context-menu-item"
					type="button"
					disabled={item.disabled}
					onmousedown={() => {
						if (item.disabled) {
							return;
						}

						closeContextMenu();
						item.action();
					}}
				>
					{item.label}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	:global(body) {
		min-width: 320px;
	}

	.workspace {
		position: relative;
		display: grid;
		height: 100vh;
		min-height: 0;
		grid-template-columns: var(--sidebar-width, 22rem) 0.36rem minmax(0, 1fr);
		background: var(--app-bg);
		overflow: hidden;
	}

	.sidebar {
		display: flex;
		min-height: 0;
		min-width: 0;
		flex-direction: column;
		container-type: inline-size;
		border-right: 1px solid var(--app-border);
		background: var(--app-bg);
		overflow: hidden;
	}

	.sidebar-resizer {
		position: relative;
		width: 0.36rem;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: col-resize;
	}

	.sidebar-resizer::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 50%;
		width: 1px;
		transform: translateX(-50%);
		background: var(--app-border);
		transition: background-color 120ms ease;
	}

	.sidebar-resizer:hover::before {
		background: var(--app-border-strong);
	}

	.panel-header,
	.card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	h2,
	p {
		margin: 0;
	}

	h2 {
		font-size: 1.05rem;
		font-weight: 600;
	}

	.eyebrow {
		margin-bottom: 0.15rem;
		font-size: 0.68rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--app-text-subtle);
	}

	.pill-row {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	.refresh-button,
	.search-trigger,
	.sort-menu select,
	.toggle,
	.project-button,
	.overlay-button {
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	.refresh-button {
		display: grid;
		height: 1.65rem;
		width: 1.65rem;
		place-items: center;
		border-radius: 0.48rem;
		color: var(--app-text-muted);
	}

	.refresh-button:hover:enabled {
		background: var(--app-control-hover);
		color: var(--app-text);
	}

	.refresh-button:disabled {
		cursor: default;
		opacity: 0.55;
	}

	.sidebar-controls {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 0.5rem;
		padding: 0.8rem 0.75rem 0.6rem;
		align-items: center;
	}

	.toggle {
		display: grid;
		height: 1.75rem;
		width: 1.75rem;
		place-items: center;
		border-radius: 0.45rem;
		color: var(--app-text-muted);
	}

	.toggle:hover {
		background: var(--app-control-hover);
		color: var(--app-text);
	}

	.search {
		display: flex;
		align-items: center;
		justify-self: end;
		gap: 0.5rem;
		height: 1.95rem;
		border: 1px solid var(--app-border);
		border-radius: 0.6rem;
		background: var(--app-control);
		width: 100%;
		max-width: 100%;
		padding: 0 0.58rem;
		color: var(--app-text-muted);
		overflow: hidden;
		cursor: text;
		transition:
			width 180ms ease,
			gap 180ms ease,
			padding 180ms ease,
			border-color 180ms ease,
			background-color 180ms ease,
			color 180ms ease;
	}

	.search.collapsed {
		justify-content: center;
		width: 1.65rem;
		gap: 0;
		padding: 0;
		border-color: transparent;
		background: transparent;
		cursor: pointer;
	}

	.search input {
		flex: 1 1 auto;
		width: 100%;
		height: 100%;
		min-height: 0;
		border: 0;
		background: transparent;
		color: var(--app-text);
		padding: 0;
		line-height: 1;
		outline: none;
		font-size: 0.82rem;
		opacity: 1;
		transition:
			width 180ms ease,
			opacity 120ms ease;
	}

	.search.collapsed input {
		width: 0;
		opacity: 0;
		pointer-events: none;
	}

	.search-trigger {
		display: grid;
		height: 1rem;
		width: 0.9rem;
		flex: 0 0 0.9rem;
		place-items: center;
		padding: 0;
		color: inherit;
	}

	.search.collapsed .search-trigger {
		height: 1.65rem;
		width: 1.65rem;
		flex-basis: 1.65rem;
	}

	.sort-menu {
		display: inline-flex;
		align-items: center;
		gap: 0.42rem;
		color: var(--app-text-subtle);
	}

	.sort-menu select {
		min-width: 7.25rem;
		height: 1.95rem;
		border: 1px solid transparent;
		border-radius: 0.6rem;
		background: transparent;
		padding: 0 1.3rem 0 0;
		appearance: none;
		font-size: 0.77rem;
		font-weight: 600;
		line-height: 1;
		color: var(--app-text-muted);
		outline: none;
	}

	.sort-menu select:hover,
	.sort-menu select:focus {
		color: var(--app-text);
	}

	.tree {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 0 0.2rem 0.85rem;
	}

	.project-group + .project-group {
		margin-top: 0.1rem;
	}

	.project-row {
		position: relative;
		display: grid;
		grid-template-columns: 1.8rem minmax(0, 1fr);
		align-items: center;
		border-radius: 0.5rem;
		overflow: visible;
	}

	.project-row.selected::before {
		content: '';
		position: absolute;
		inset: 0 0 0 calc(1.8rem - 7px);
		border-radius: 0.5rem;
		background: var(--app-control-hover);
		pointer-events: none;
	}

	.toggle,
	.project-button {
		position: relative;
		z-index: 1;
	}

	.project-button {
		display: flex;
		min-width: 0;
		width: 100%;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.36rem 0.58rem 0.36rem 0;
		text-align: left;
	}

	.project-copy {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 0.42rem;
		white-space: nowrap;
	}

	.project-name {
		display: inline-flex;
		min-width: 0;
		align-items: center;
		gap: 0.48rem;
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--app-text);
	}

	.project-status {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		line-height: 1;
		font-size: 0.72rem;
		color: var(--app-text-muted);
	}

	:global(.project-icon-uncreated) {
		color: var(--app-text-subtle);
	}

	:global(.project-icon-running) {
		color: #70bc7b;
	}

	:global(.project-icon-paused) {
		color: #7fc4ea;
	}

	:global(.project-icon-warning) {
		color: #c7a45f;
	}

	:global(.project-icon-neutral) {
		color: var(--app-text-muted);
	}

	:global(.project-icon-exited) {
		color: #c76a68;
	}

	.project-meta {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.22rem;
		flex: none;
		margin-left: auto;
		min-width: 1.25rem;
		text-align: right;
		font-size: 0.72rem;
		font-weight: 700;
		color: var(--app-text-subtle);
		transform: translateX(-6px);
	}

	.project-watch-indicator {
		display: inline-flex;
		align-items: center;
		color: var(--app-text-muted);
	}

	.service-list {
		margin-left: 1.9rem;
		padding: 0.08rem 0 0.28rem 0.68rem;
	}

	.service-row {
		position: relative;
		display: flex;
		gap: 0.58rem;
		padding: 0.24rem 0;
		overflow: visible;
		border-radius: 0.55rem;
	}

	.service-row.selected {
		background: var(--app-control-hover);
		padding-left: 7px;
	}

	.service-button {
		display: flex;
		width: 100%;
		min-width: 0;
		align-items: flex-start;
		gap: 0.58rem;
		padding: 0.02rem 3.9rem 0.02rem 0;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
		text-align: left;
	}

	.service-state {
		display: inline-flex;
		padding-top: 0.16rem;
		color: #c66c6b;
	}

	.service-state-running {
		color: #73c37f;
	}

	.service-state-paused {
		color: #c7a45f;
	}

	.service-state-exited {
		color: #c66c6b;
	}

	.service-state-uncreated {
		color: var(--app-text-subtle);
	}

	.service-copy {
		min-width: 0;
		font-size: 0.8rem;
	}

	.service-title,
	.row-title {
		display: flex;
		gap: 0.35rem;
		font-weight: 600;
		color: var(--app-text);
	}

	.service-container,
	.row-subtitle {
		color: var(--app-text-muted);
		font-weight: 500;
	}

	.service-subtitle {
		color: var(--app-text-muted);
	}

	.health-tag {
		color: #7fe39a;
	}

	.row-actions {
		position: absolute;
		top: 50%;
		right: 0.32rem;
		display: inline-flex;
		gap: 0.28rem;
		transform: translateY(-50%);
		opacity: 0;
		pointer-events: none;
		transition: opacity 120ms ease;
		z-index: 3;
	}

	.project-row:hover .row-actions {
		opacity: 1;
		pointer-events: auto;
	}

	.overlay-button {
		display: grid;
		height: 1.7rem;
		width: 1.7rem;
		place-items: center;
		border-radius: 0.5rem;
		border: 1px solid var(--app-border);
		background: var(--app-surface-raised);
		color: var(--app-text-muted);
		box-shadow: 0 10px 22px rgba(0, 0, 0, 0.32);
	}

	.overlay-button:hover:enabled {
		border-color: var(--app-border-strong);
		background: var(--app-surface-hover);
		color: var(--app-text);
	}

	.overlay-button:disabled {
		cursor: default;
		opacity: 0.55;
	}

	.tooltip-anchor,
	[data-tooltip]:not([data-tooltip='']) {
		position: relative;
	}

	.tooltip-anchor {
		display: inline-flex;
	}

	.tooltip-anchor[data-tooltip]::after,
	[data-tooltip]:not([data-tooltip=''])::after {
		content: attr(data-tooltip);
		position: absolute;
		display: block;
		box-sizing: border-box;
		isolation: isolate;
		mix-blend-mode: normal;
		backdrop-filter: none;
		-webkit-backdrop-filter: none;
		top: calc(100% + 0.42rem);
		bottom: auto;
		width: max-content;
		max-width: min(18rem, calc(100cqw - 1rem));
		padding: 0.36rem 0.52rem;
		border: 1px solid var(--app-border-strong);
		border-radius: 0.45rem;
		background: var(--app-bg) !important;
		box-shadow: 0 14px 34px rgba(0, 0, 0, 0.68);
		color: var(--app-text);
		font-size: 0.72rem;
		line-height: 1.2;
		white-space: pre-line;
		text-align: left;
		overflow-wrap: break-word;
		word-break: normal;
		opacity: 0;
		visibility: hidden;
		pointer-events: none;
		will-change: opacity, transform;
		transition:
			opacity 0s linear 320ms,
			transform 0s linear 320ms,
			visibility 0s linear 320ms;
		z-index: 30;
	}

	.tooltip-anchor[data-tooltip]:hover::after,
	[data-tooltip]:not([data-tooltip='']):hover::after {
		opacity: 1;
		visibility: visible;
		transition-delay: 650ms, 650ms, 650ms;
	}

	.tooltip-anchor[data-tooltip]:hover::after {
		left: auto;
		right: 0;
		transform: translateY(0);
	}

	[data-tooltip]:not([data-tooltip='']):hover::after {
		left: auto;
		right: 0;
		transform: translateY(0);
	}

	.row-tooltip-bubble {
		position: absolute;
		top: calc(100% + 0.42rem);
		left: 1.8rem;
		z-index: 40;
		display: block;
		box-sizing: border-box;
		width: max-content;
		max-width: min(18rem, calc(100cqw - 2.4rem));
		padding: 0.36rem 0.52rem;
		border: 1px solid var(--app-border-strong);
		border-radius: 0.45rem;
		background: var(--app-bg);
		box-shadow: 0 14px 34px rgba(0, 0, 0, 0.68);
		color: var(--app-text);
		font-size: 0.72rem;
		line-height: 1.2;
		white-space: pre-line;
		text-align: left;
		overflow-wrap: break-word;
		word-break: normal;
		opacity: 0;
		visibility: hidden;
		pointer-events: none;
		transform: translateY(-2px);
		transition:
			opacity 0s linear 320ms,
			transform 0s linear 320ms,
			visibility 0s linear 320ms;
	}

	.row-tooltip-trigger:hover + .row-tooltip-bubble {
		opacity: 1;
		visibility: visible;
		transform: translateY(0);
		transition-delay: 650ms, 650ms, 650ms;
	}

	.project-row:has(.row-actions:hover) .row-tooltip-bubble {
		opacity: 0;
		visibility: hidden;
		transform: translateY(-2px);
		transition-delay: 0s, 0s, 0s;
	}

	.status-line[data-tooltip]:hover::after {
		left: auto;
		right: 0;
		max-width: min(28rem, calc(100vw - 2rem));
	}

	.tooltip-anchor[data-tooltip]::after,
	[data-tooltip]:not([data-tooltip=''])::after {
		transform: translateY(-2px);
	}

	.context-menu-backdrop {
		position: absolute;
		inset: 0;
		z-index: 20;
		background: transparent;
		border: 0;
		cursor: default;
	}

	.context-menu {
		position: absolute;
		z-index: 21;
		display: flex;
		min-width: 12.5rem;
		flex-direction: column;
		padding: 0.28rem;
		border: 1px solid var(--app-border);
		border-radius: 0.7rem;
		background: var(--app-surface-raised);
		box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42);
	}

	.context-menu-item {
		padding: 0.42rem 0.58rem;
		border: 0;
		border-radius: 0.48rem;
		background: transparent;
		color: var(--app-text);
		font-size: 0.78rem;
		text-align: left;
		cursor: pointer;
	}

	.context-menu-item:hover {
		background: var(--app-control-hover);
		color: var(--app-text);
	}

	.context-menu-item:disabled {
		cursor: default;
		opacity: 0.42;
	}

	.context-menu-item:disabled:hover {
		background: transparent;
		color: var(--app-text);
	}

	.sidebar-empty,
	.service-empty,
	.empty-state {
		display: grid;
		place-items: center;
		border-radius: 0.8rem;
		background: var(--app-control);
		font-size: 0.8rem;
		color: var(--app-text-muted);
	}

	.sidebar-empty {
		margin: 0 0.55rem;
		min-height: 8rem;
	}

	.service-empty {
		margin-right: 0.5rem;
		min-height: 2.3rem;
		font-size: 0.74rem;
	}

	.panel {
		display: flex;
		min-height: 0;
		flex-direction: column;
		padding: 1rem 1rem 1.15rem;
		overflow: hidden;
	}

	.panel-header {
		padding-bottom: 0.95rem;
		border-bottom: 1px solid var(--app-border);
	}

	.panel-heading {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.status-line {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0;
		border: 0;
		background: transparent;
		font-size: 0.8rem;
		color: var(--app-text-muted);
		cursor: pointer;
		text-align: left;
	}

	.status-dot {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 0.7rem;
		width: 0.7rem;
		border-radius: 999px;
		background: currentColor;
		color: #d1a15f;
		box-shadow: 0 0 0 0.16rem rgba(209, 161, 95, 0.15);
	}

	.status-dot.connected {
		color: #69d08b;
		box-shadow: 0 0 0 0.16rem rgba(105, 208, 139, 0.15);
	}

	.status-dot.error-state {
		color: #d08266;
		box-shadow: 0 0 0 0.16rem rgba(208, 130, 102, 0.15);
	}

	.status-dot.paused-status {
		background: transparent;
		box-shadow: none;
	}

	.content-grid {
		display: grid;
		flex: 1;
		min-height: 0;
		min-width: 0;
		grid-template-columns: 1fr;
		grid-auto-rows: min-content;
		grid-template-areas:
			'summary'
			'processes'
			'builds'
			'logs';
		align-content: start;
		gap: 0.9rem;
		margin-top: 0.95rem;
		overflow: auto;
		padding-right: 0.1rem;
	}

	.card {
		display: flex;
		min-height: 0;
		flex-direction: column;
		border: 1px solid var(--app-border);
		border-radius: 0.95rem;
		background: var(--app-surface);
		padding: 0.95rem 1rem;
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
	}

	.summary-card .card-header,
	.card-header-compact {
		margin-bottom: 0.9rem;
	}

	.summary-card {
		grid-area: summary;
	}

	.log-card {
		grid-area: logs;
	}

	.process-card {
		grid-area: processes;
	}

	.build-card {
		grid-area: builds;
	}

	.pill {
		border-radius: 999px;
		background: var(--app-control-hover);
		padding: 0.28rem 0.56rem;
		font-size: 0.73rem;
		font-weight: 700;
		color: var(--app-text-muted);
	}

	.active-pill,
	.ok-state {
		color: #d4f0da;
		background: rgba(61, 136, 88, 0.18);
	}

	.warn-state {
		color: #f1ddbb;
		background: rgba(164, 126, 67, 0.18);
	}

	.compact-list,
	.config-list,
	.build-list,
	.build-stream-list,
	.process-list,
	.log-list {
		display: flex;
		min-height: 0;
		flex-direction: column;
		gap: 0.15rem;
		overflow: auto;
	}

	.compact-row,
	.build-row,
	.build-stream-row,
	.log-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		border-radius: 0.65rem;
		padding: 0.55rem 0.65rem;
		background: var(--app-surface-raised);
	}

	.config-list {
		margin-bottom: 0.65rem;
	}

	.config-item {
		display: flex;
		flex-direction: column;
		gap: 0.12rem;
	}

	.config-button {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 0.65rem;
		border: 0;
		border-radius: 0.65rem;
		background: var(--app-surface-raised);
		color: inherit;
		cursor: pointer;
		text-align: left;
	}

	.config-button:hover {
		background: var(--app-surface-hover);
	}

	.config-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.18rem;
	}

	.config-copy .row-title {
		align-items: center;
	}

	.config-output {
		border-radius: 0.7rem;
		background: var(--app-bg);
		overflow: auto;
	}

	.config-output pre {
		margin: 0;
		padding: 0.8rem 0.9rem;
		color: var(--app-text);
		font-size: 0.73rem;
		line-height: 1.45;
		white-space: pre-wrap;
		word-break: break-word;
		font-family: 'SF Mono', 'Monaco', 'Cascadia Code', monospace;
	}

	.config-output-state {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.8rem 0.9rem;
		color: var(--app-text-muted);
		font-size: 0.76rem;
	}

	.build-list {
		margin-bottom: 0.4rem;
	}

	.build-stream-row {
		justify-content: flex-start;
		padding-inline: 0.7rem;
		font-size: 0.78rem;
	}

	.build-stream-source {
		min-width: 4.5rem;
		color: var(--app-text-subtle);
		font-size: 0.72rem;
		font-weight: 600;
	}

	.row-tail {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		font-size: 0.77rem;
		color: var(--app-text-muted);
	}

	.state-chip {
		border-radius: 999px;
		padding: 0.18rem 0.48rem;
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		background: rgba(126, 74, 74, 0.22);
		color: #ffc0bf;
	}

	.state-chip-running {
		color: #d4f0da;
		background: rgba(61, 136, 88, 0.18);
	}

	.state-chip-paused {
		color: #d6edfa;
		background: rgba(76, 127, 161, 0.2);
	}

	.state-chip-uncreated {
		color: #c1c7ce;
		background: rgba(102, 107, 114, 0.22);
	}

	.state-chip-created {
		color: #d5dbe2;
		background: rgba(112, 120, 129, 0.22);
	}

	.state-chip-unknown {
		color: #d5dbe2;
		background: rgba(112, 120, 129, 0.22);
	}

	.state-chip-mixed {
		color: #f1ddbb;
		background: rgba(164, 126, 67, 0.18);
	}

	.state-chip-exited {
		color: #ffc0bf;
		background: rgba(126, 74, 74, 0.22);
	}

	.log-row {
		justify-content: flex-start;
		padding-inline: 0.7rem;
		font-size: 0.78rem;
	}

	.log-level {
		min-width: 2.7rem;
		border-radius: 999px;
		padding: 0.18rem 0.45rem;
		text-align: center;
		font-size: 0.66rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.log-ok {
		background: rgba(61, 136, 88, 0.18);
		color: #bef1cd;
	}

	.log-info {
		background: var(--app-control-hover);
		color: var(--app-text-muted);
	}

	.log-warn {
		background: rgba(160, 115, 65, 0.18);
		color: #f0cf9f;
	}

	.log-error {
		background: rgba(141, 61, 61, 0.2);
		color: #ffb6b3;
	}

	.log-time {
		width: 3rem;
		color: var(--app-text-subtle);
		font-variant-numeric: tabular-nums;
	}

	.log-message {
		color: var(--app-text);
	}

	.process-group {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		border-radius: 0.75rem;
		padding: 0.7rem;
		background: var(--app-surface-raised);
	}

	.process-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.process-replica {
		border-radius: 999px;
		padding: 0.18rem 0.48rem;
		background: var(--app-control-hover);
		color: var(--app-text-muted);
		font-size: 0.7rem;
		font-weight: 700;
	}

	.process-table {
		display: flex;
		flex-direction: column;
		gap: 0.18rem;
		overflow: auto;
	}

	.process-cards {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.process-item {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		border-radius: 0.55rem;
		background: var(--app-bg);
		padding: 0.6rem;
	}

	.process-meta {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(4.5rem, max-content));
		gap: 0.45rem;
	}

	.process-meta-item {
		display: flex;
		flex-direction: column;
		gap: 0.12rem;
		min-width: 0;
	}

	.process-meta-label {
		font-size: 0.66rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--app-text-subtle);
	}

	.process-meta-item strong,
	.command-name {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--app-text);
	}

	.command-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: start;
		column-gap: 0.8rem;
		row-gap: 0.35rem;
	}

	.command-path {
		font-size: 0.68rem;
		color: var(--app-text-subtle);
		font-family: 'SF Mono', 'Monaco', 'Cascadia Code', monospace;
		justify-self: end;
		max-width: 20rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: right;
	}

	.command-line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.45rem;
		min-width: 0;
	}

	.command-inline-args {
		font-size: 0.74rem;
		color: var(--app-text-muted);
		font-family: 'SF Mono', 'Monaco', 'Cascadia Code', monospace;
		word-break: break-word;
	}

	.empty-state {
		min-height: 9rem;
	}

	@media (max-width: 700px) {
		.panel {
			display: none;
		}

		.workspace {
			grid-template-columns: 1fr;
		}

		.sidebar {
			min-height: 0;
			border-right: 0;
		}

		.sidebar-resizer {
			display: none;
		}
	}

	@media (max-width: 640px) {
		.sidebar-controls {
			grid-template-columns: auto minmax(0, 1fr) auto;
			gap: 0.42rem;
		}

		.sort-menu select {
			min-width: 0;
			width: 5.9rem;
		}
	}
</style>
