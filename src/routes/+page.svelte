<script lang="ts">
	import { browser } from '$app/environment';
	import { eq } from '@tanstack/db';
	import { useLiveQuery } from '@tanstack/svelte-db';
	import { onMount, tick } from 'svelte';

	import Icon from '$lib/components/Icon.svelte';
	import ProjectServicesList from '$lib/components/ProjectServicesList.svelte';
	import { isReplacementBuild, latestBuildFailure, mergeBuilds } from '$lib/central/build-state';
	import {
		buildCompletion,
		parseOutputMessage,
		readBuildOutput,
		type OutputMessage
	} from '$lib/central/output-stream';
	import { resourcePressure } from '$lib/central/resource-state';
	import {
		appendLog,
		areProjectServicesStoppedWithoutError,
		buildsCollection,
		checkHealth,
		composeLogsStreamUrl,
		composeServiceUrl,
		executeProjectCommand,
		type ComposeBuild,
		killProjectProcess,
		loadProjectConfig,
		loadBuilds,
		loadProjectProcesses,
		loadProjectResources,
		loadRuntimeStatus,
		loadSystemDiskUsage,
		loadSystemInfo,
		type ComposeProcessSnapshot,
		type ComposeProject,
		type ComposeService,
		type LocalSettings,
		type LogEntry,
		type ProjectResources,
		type ResourceLimits,
		type ResourceUsage,
		type ResourceUtilization,
		type RuntimeStatus,
		type UiState,
		hydrateBuilds,
		hydrateProjects,
		invalidateProjectServices,
		logsCollection,
		pauseServices,
		projectsCollection,
		refreshProjectsFromServer,
		removeServices,
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
		startContainer,
		startProject,
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
		danger?: boolean;
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

	type ServiceLogEntry = {
		id: string;
		projectId: string;
		serviceId: string;
		time: string;
		source: string;
		stream: string;
		message: string;
		isError: boolean;
		isCommand?: boolean;
		commandStatus?: 'running' | 'succeeded' | 'failed';
		execId?: string;
	};

	type ConfigPanelState = {
		open: boolean;
		loading: boolean;
		error: string;
		content: string;
	};

	type Toast = {
		id: string;
		level: 'ok' | 'info' | 'warn' | 'error';
		title: string;
		message: string;
	};

	type ResourceMetric = {
		label: string;
		value: string;
		hoverValue: string;
		tooltip: string;
		percent?: number;
	};

	type HashSelection = {
		projectId: string;
		serviceId: string;
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
	let serviceLogEntries = $state<Record<string, ServiceLogEntry[]>>({});
	let serviceLogStreamErrors = $state<Record<string, string>>({});
	let serviceLogPanels = $state<Record<string, boolean>>({});
	let serviceCommandInputs = $state<Record<string, string>>({});
	let serviceCommandBusy = $state<Record<string, boolean>>({});
	let processPanels = $state<Record<string, boolean>>({});
	let configPanels = $state<Record<string, ConfigPanelState>>({});
	let buildPanels = $state<Record<string, boolean>>({});
	let toasts = $state<Toast[]>([]);
	let toastSequence = 0;
	const buildStreamControllers = new Map<string, AbortController>();
	const capturedBuilds = new Set<string>();
	let buildStreamErrors = $state<Record<string, string>>({});
	let buildHistoryError = $state('');
	let refreshingBuilds = false;
	let disposed = false;
	const watchEventSources = new Map<string, EventSource>();
	const serviceLogEventSources = new Map<string, EventSource>();
	const execCommandLogEntries = new Map<string, { key: string; entryId: string }>();
	const pendingExecCompletions = new Map<string, number>();
	const watchBuildIds = new Map<string, string>();
	const watchBuildTargets = new Map<string, ActiveBuildTarget>();

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
	const sidebarServicesQuery = useLiveQuery(
		(q) => q.from({ services: servicesCollection }),
		[() => expandedProjectIdList.join('|'), () => serviceQueryEpoch]
	);
	const sidebarServices = $derived((sidebarServicesQuery.data ?? []) as ComposeService[]);
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
			? [
					...new Map(
						builds
							.filter(
								(build) =>
									build.projectId === selectedProject.id || build.projectName === selectedProject.name
							)
							.map((build) => [build.id, build] as const)
					).values()
				]
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
	let systemInfo = $state<Record<string, unknown> | null>(null);
	let systemDiskUsage = $state<Record<string, unknown> | null>(null);
	let runtimeStatus = $state<RuntimeStatus | null>(null);
	let projectResources = $state<ProjectResources | null>(null);
	let pendingHashSelection = $state<HashSelection | null>(
		browser ? parseSelectionHash(window.location.hash) : null
	);
	let contextMenu = $state<ContextMenuState | null>(null);
	const ACTION_SETTLE_ATTEMPTS = 8;
	const ACTION_SETTLE_DELAY_MS = 350;
	const LS_POLL_INTERVAL_MS = 10_000;
	const BUILD_STREAM_END_THRESHOLD_PX = 24;

	function parseSelectionHash(hash: string): HashSelection | null {
		const raw = hash.replace(/^#/, '').replace(/^\?/, '');

		if (!raw) {
			return null;
		}

		const params = new URLSearchParams(raw);
		const projectId = params.get('project') || params.get('p') || '';
		const serviceId = params.get('service') || params.get('container') || params.get('c') || '';

		if (!projectId) {
			return null;
		}

		return { projectId, serviceId };
	}

	function selectionHash(projectId: string, serviceId: string) {
		const params = new URLSearchParams();
		params.set('project', projectId);

		if (serviceId) {
			params.set('service', serviceId);
		}

		return `#${params.toString()}`;
	}

	function writeSelectionHash(projectId: string, serviceId: string) {
		if (!browser || !projectId) {
			return;
		}

		const hash = selectionHash(projectId, serviceId);

		if (window.location.hash === hash) {
			return;
		}

		window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
	}

	$effect(() => {
		if (!visibleProjects.length) {
			if (selectedProjectId) {
				selectProject('');
			}

			return;
		}

		const exists = visibleProjects.some((project) => project.id === selectedProjectId);
		const hashProjectExists = pendingHashSelection?.projectId
			? visibleProjects.some((project) => project.id === pendingHashSelection?.projectId)
			: false;

		if (hashProjectExists) {
			return;
		}

		if (!selectedProjectId || !exists) {
			selectProject(visibleProjects[0].id);
		}
	});

	$effect(() => {
		const target = pendingHashSelection;

		if (!target) {
			return;
		}

		const project = visibleProjects.find((entry) => entry.id === target.projectId);

		if (!project) {
			return;
		}

		if (selectedProjectId !== target.projectId) {
			selectProject(target.projectId);
			return;
		}

		if (!target.serviceId) {
			pendingHashSelection = null;
			return;
		}

		if (!selectedProjectServicesQuery.isReady) {
			return;
		}

		const service = selectedServices.find((entry) => entry.id === target.serviceId);

		if (service) {
			setProjectExpanded(target.projectId, true);

			if (selectedContainerId !== target.serviceId) {
				selectContainer(target.projectId, target.serviceId);
				return;
			}
		}

		pendingHashSelection = null;
	});

	$effect(() => {
		if (pendingHashSelection || !selectedProjectId) {
			return;
		}

		writeSelectionHash(selectedProjectId, selectedContainerId);
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
		return `${base} ${autoRefreshPaused ? 'Polling paused.' : 'Polling every 10s.'}`;
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

		if (build.kind === 'watch' && build.status === 'succeeded') {
			return 'watching';
		}

		return build.status === 'succeeded' ? 'succeeded' : 'failed';
	}

	function buildRowTitle(build: ComposeBuild) {
		if (build.kind === 'watch') {
			return `${build.targetName || build.projectName} watch`;
		}

		return build.projectName ? `${build.projectName} build #${build.id}` : `Build #${build.id}`;
	}

	function buildPanelOpen(buildId: string) {
		return buildPanels[buildId] ?? true;
	}

	function toggleBuildPanel(buildId: string) {
		buildPanels = {
			...buildPanels,
			[buildId]: !buildPanelOpen(buildId)
		};
	}

	function keepBuildOutputPinned(node: HTMLElement) {
		let pinnedToEnd = true;
		let animationFrame = 0;

		const isAtEnd = () =>
			node.scrollHeight - node.scrollTop - node.clientHeight <= BUILD_STREAM_END_THRESHOLD_PX;

		const rememberScrollPosition = () => {
			pinnedToEnd = isAtEnd();
		};

		const scrollToEnd = () => {
			window.cancelAnimationFrame(animationFrame);
			animationFrame = window.requestAnimationFrame(() => {
				if (pinnedToEnd) {
					node.scrollTop = node.scrollHeight;
				}
			});
		};

		const observer = new MutationObserver(scrollToEnd);
		node.addEventListener('scroll', rememberScrollPosition, { passive: true });
		observer.observe(node, { childList: true, subtree: true, characterData: true });
		scrollToEnd();

		return {
			destroy() {
				window.cancelAnimationFrame(animationFrame);
				observer.disconnect();
				node.removeEventListener('scroll', rememberScrollPosition);
			}
		};
	}

	function buildStreamEntriesForBuild(buildId: string) {
		return buildStreamEntries.filter((entry) => entry.buildId === buildId);
	}

	function serviceLogKey(projectId: string, serviceId: string) {
		return `${projectId}:${serviceId}`;
	}

	function serviceLogsFor(project: ComposeProject, service: ComposeService) {
		return serviceLogEntries[serviceLogKey(project.id, service.id)] ?? [];
	}

	function serviceLogOpen(project: ComposeProject, service: ComposeService) {
		return serviceLogPanels[serviceLogKey(project.id, service.id)] ?? false;
	}

	function serviceLogErrorCount(project: ComposeProject, service: ComposeService) {
		return serviceLogsFor(project, service).filter((entry) => entry.isError).length;
	}

	function clearServiceLogs(project: ComposeProject, service: ComposeService) {
		serviceLogEntries = {
			...serviceLogEntries,
			[serviceLogKey(project.id, service.id)]: []
		};
	}

	function clearActiveServiceLogs() {
		if (!selectedProject) {
			return;
		}

		const openSelectedService =
			selectedContainer && serviceLogOpen(selectedProject, selectedContainer) ? selectedContainer : undefined;
		const openService =
			openSelectedService ?? selectedServices.find((service) => serviceLogOpen(selectedProject, service));

		if (openService) {
			clearServiceLogs(selectedProject, openService);
		}
	}

	function handleGlobalKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			clearActiveServiceLogs();
		}
	}

	function processPanelOpen(entryId: string) {
		return processPanels[entryId] ?? false;
	}

	function toggleProcessPanel(entryId: string) {
		processPanels = {
			...processPanels,
			[entryId]: !processPanelOpen(entryId)
		};
	}

	function splitComposePath(path: string | undefined) {
		if (!path) {
			return [];
		}

		return [...new Set(path.split(',').map((entry) => entry.trim()).filter(Boolean))];
	}

	function composeFilePaths(project: ComposeProject | undefined) {
		return splitComposePath(project?.path);
	}

	function actionComposePaths(project: ComposeProject, service?: ComposeService) {
		const paths = splitComposePath(service?.composePath || project.path);

		if (service) {
			return paths.slice(0, 1);
		}

		return paths;
	}

	function actionTarget(project: ComposeProject, path: string) {
		return { id: project.id, path };
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
		const current = builds;

		for (const [buildId, target] of Object.entries(activeBuildTargets)) {
			const build = current.find((entry) => entry.id === buildId);

			if (!build || build.status !== 'running') {
				continue;
			}

			if (target.projectId === projectId) {
				return target;
			}
		}

		return null;
	}

	function busyActionKindForProject(projectId: string) {
		for (const kind of ['stop', 'start', 'up-no-build', 'restart', 'watching', 'remove']) {
			if (busyAction?.startsWith(`${kind}:${projectId}:`)) {
				return kind;
			}
		}

		return '';
	}

	function projectStartButtonSpinning(project: ComposeProject) {
		const target = activeBuildTarget(project.id);
		return Boolean(target) || Boolean(busyActionKindForProject(project.id));
	}

	function projectPendingStatusLabel(project: ComposeProject) {
		if (busyAction === `watching:${project.id}:project`) {
			return project.watching ? 'stopping watch' : 'enabling watch';
		}

		if (busyAction === `restart:${project.id}:project`) {
			return 'restarting';
		}

		if (busyAction === `stop:${project.id}:project`) {
			return 'stopping';
		}

		if (
			busyAction === `start:${project.id}:project` ||
			busyAction === `up-no-build:${project.id}:project`
		) {
			return 'starting';
		}

		const target = activeBuildTarget(project.id);

		if (target) {
			return 'building';
		}

		const busyKind = busyActionKindForProject(project.id);

		if (busyKind === 'restart') {
			return 'restarting';
		}

		if (busyKind === 'stop') {
			return 'stopping';
		}

		if (busyKind === 'remove') {
			return 'removing';
		}

		if (busyKind === 'start' || busyKind === 'up-no-build' || busyKind === 'watching') {
			return 'starting';
		}

		return '';
	}

	function projectDisplayStatusLabel(project: ComposeProject | undefined) {
		if (!project) {
			return 'Unknown';
		}

		return (
			projectPendingStatusLabel(project) ||
			(latestBuildFailure(builds, project) ? 'Build failed' : project.statusLabel) ||
			'Unknown'
		);
	}

	function projectDisplayChipClass(project: ComposeProject | undefined) {
		if (!project) {
			return '';
		}

		return projectPendingStatusLabel(project)
			? 'warn-state'
			: latestBuildFailure(builds, project)
				? 'state-chip-exited'
				: projectStateChipClass(project);
	}

	function serviceStartButtonSpinning(project: ComposeProject, service: ComposeService) {
		const target = activeBuildTarget(project.id);
		return (
			Boolean(target && target.serviceId === service.id) ||
			busyAction === `stop:${project.id}:${service.id}` ||
			busyAction === `start:${project.id}:${service.id}` ||
			busyAction === `up-no-build:${project.id}:${service.id}` ||
			busyAction === `restart:${project.id}:${service.id}` ||
			busyAction === `watching:${project.id}:${service.id}` ||
			busyAction === `remove:${project.id}:${service.id}`
		);
	}

	function servicePendingStatusLabel(project: ComposeProject | undefined, service: ComposeService) {
		if (!project) {
			return '';
		}

		if (busyAction === `restart:${project.id}:${service.id}`) {
			return 'restarting';
		}

		if (busyAction === `stop:${project.id}:${service.id}`) {
			return 'stopping';
		}

		if (busyAction === `remove:${project.id}:${service.id}`) {
			return 'removing';
		}

		if (
			busyAction === `start:${project.id}:${service.id}` ||
			busyAction === `up-no-build:${project.id}:${service.id}` ||
			busyAction === `watching:${project.id}:${service.id}`
		) {
			return 'starting';
		}

		const target = activeBuildTarget(project.id);

		if (target?.serviceId === service.id) {
			return 'building';
		}

		return '';
	}

	function serviceDisplayStateLabel(project: ComposeProject | undefined, service: ComposeService) {
		return (
			servicePendingStatusLabel(project, service) ||
			(project && latestBuildFailure(builds, project, service) ? 'build failed' : service.state)
		);
	}

	function serviceDisplayStatusText(project: ComposeProject | undefined, service: ComposeService) {
		return (
			servicePendingStatusLabel(project, service) ||
			(project && latestBuildFailure(builds, project, service)
				? 'Build failed — see build output'
				: service.stateText)
		);
	}

	function serviceDisplayChipClass(project: ComposeProject | undefined, service: ComposeService) {
		return servicePendingStatusLabel(project, service)
			? 'state-chip-mixed'
			: project && latestBuildFailure(builds, project, service)
				? 'state-chip-exited'
				: serviceStateChipClass(service);
	}

	function currentBuilds() {
		return [...buildsCollection.state.values()] as ComposeBuild[];
	}

	function upsertLocalBuild(build: ComposeBuild) {
		hydrateBuilds([...currentBuilds().filter((entry) => entry.id !== build.id), build]);
	}

	function currentWatchBuild(projectId: string) {
		const buildId = watchBuildIds.get(projectId);
		return buildId ? currentBuilds().find((build) => build.id === buildId) : undefined;
	}

	function setBuildStatus(buildId: string, status: 'running' | 'succeeded' | 'failed') {
		const nextBuilds = currentBuilds().map((build) =>
			build.id === buildId
				? {
						...build,
						status,
						finishedAt: status === 'running' ? null : new Date().toISOString(),
						success: status === 'running' ? null : status === 'succeeded'
					}
				: build
		);

		hydrateBuilds(nextBuilds);

		if (status !== 'running') {
			setActiveBuildTarget(buildId, null);
		}
	}

	function clearActiveTargets(projectId: string, serviceId?: string) {
		for (const [buildId, target] of Object.entries(activeBuildTargets)) {
			if (target.projectId !== projectId) {
				continue;
			}

			if (serviceId && target.serviceId !== serviceId) {
				continue;
			}

			// Container refreshes and stop actions do not determine a build's result.
			setActiveBuildTarget(buildId, null);
		}
	}

	function ensureWatchBuild(project: Pick<ComposeProject, 'id' | 'name'>, service?: ComposeService) {
		const existing = currentWatchBuild(project.id);
		const target = {
			projectId: project.id,
			...(service ? { serviceId: service.id } : {})
		};

		watchBuildTargets.set(project.id, target);

		if (existing) {
			const nextBuild = {
				...existing,
				status: 'running' as const,
				finishedAt: null,
				success: null,
				targetName: service?.serviceName ?? existing.targetName ?? project.name
			};
			upsertLocalBuild(nextBuild);
			setActiveBuildTarget(existing.id, target);
			return nextBuild;
		}

		const build: ComposeBuild = {
			id: `watch-${project.id}-${Date.now()}-${crypto.randomUUID()}`,
			projectId: project.id,
			projectName: project.name,
			kind: 'watch',
			serviceName: service?.serviceName,
			targetName: service?.serviceName ?? project.name,
			status: 'running',
			startedAt: new Date().toISOString(),
			finishedAt: null,
			success: null,
			streamUrl: ''
		};

		upsertLocalBuild(build);
		watchBuildIds.set(project.id, build.id);
		setActiveBuildTarget(build.id, {
			projectId: project.id,
			...(service ? { serviceId: service.id } : {})
		});

		return build;
	}

	function appendBuildStreamEntry(
		buildId: string,
		projectId: string,
		payload: {
			stream?: string;
			source?: string;
			message?: string;
			time?: string;
		},
		fallbackSource: string
	) {
		const message = String(payload.message ?? '');

		if (!message.trim()) {
			return;
		}

		buildStreamEntries = [
			...buildStreamEntries,
			{
				id: `${buildId}-${Date.now()}-${crypto.randomUUID()}`,
				buildId,
				projectId,
				time: formatBuildTime(String(payload.time ?? '')) || formatBuildTime(new Date().toISOString()),
				source: String(payload.source ?? '').trim() || fallbackSource,
				stream: String(payload.stream ?? ''),
				message
			}
		];
	}

	function isErrorLogLine(stream: string, message: string) {
		return stream.toLowerCase() === 'stderr' || /\b(error|failed|exception|panic|fatal)\b/i.test(message);
	}

	function parseExecCompletionMessage(message: string) {
		const match = /^exec\s+([a-f0-9]+)\s+exited with code\s+(-?\d+)$/i.exec(message.trim());

		if (!match) {
			return null;
		}

		return {
			execId: match[1],
			code: Number(match[2])
		};
	}

	function parseExecStartMessage(message: string) {
		const match = /^exec\s+([a-f0-9]+)\s+started(?::.*)?$/i.exec(message.trim());
		return match ? { execId: match[1] } : null;
	}

	function appendServiceLogEntry(project: ComposeProject, service: ComposeService, entry: Omit<ServiceLogEntry, 'id' | 'projectId' | 'serviceId'>) {
		const key = serviceLogKey(project.id, service.id);
		const id = `${key}-${Date.now()}-${crypto.randomUUID()}`;

		serviceLogEntries = {
			...serviceLogEntries,
			[key]: [
				...(serviceLogEntries[key] ?? []),
				{
					...entry,
					id,
					projectId: project.id,
					serviceId: service.id
				}
			].slice(-500)
		};

		return id;
	}

	function latestRunningCommandEntryId(project: ComposeProject, service: ComposeService) {
		const key = serviceLogKey(project.id, service.id);
		const entries = serviceLogEntries[key] ?? [];

		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];

			if (entry.isCommand && entry.commandStatus === 'running') {
				return entry.id;
			}
		}

		return '';
	}

	function markServiceCommandEntry(
		project: ComposeProject,
		service: ComposeService,
		status: 'running' | 'succeeded' | 'failed',
		options: { entryId?: string; execId?: string } = {}
	) {
		const key = serviceLogKey(project.id, service.id);
		const entries = serviceLogEntries[key] ?? [];
		let targetIndex = -1;

		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];

			if (
				(options.entryId && entry.id === options.entryId) ||
				(options.execId && entry.execId === options.execId) ||
				(!options.entryId && !options.execId && entry.isCommand && entry.commandStatus === 'running')
			) {
				targetIndex = index;
				break;
			}
		}

		if (targetIndex < 0) {
			return false;
		}

		serviceLogEntries = {
			...serviceLogEntries,
			[key]: entries.map((entry, index) =>
				index === targetIndex
					? {
							...entry,
							commandStatus: status,
							execId: options.execId ?? entry.execId,
							isError: status === 'failed' || entry.isError
						}
					: entry
			)
		};

		return true;
	}

	function trackExecCommand(project: ComposeProject, service: ComposeService, execId: string, entryId = latestRunningCommandEntryId(project, service)) {
		if (!entryId) {
			return false;
		}

		execCommandLogEntries.set(execId, {
			key: serviceLogKey(project.id, service.id),
			entryId
		});
		return markServiceCommandEntry(project, service, 'running', { entryId, execId });
	}

	function closeServiceLogStream(key: string) {
		const source = serviceLogEventSources.get(key);

		if (source) {
			source.close();
			serviceLogEventSources.delete(key);
		}
	}

	function subscribeToServiceLogs(project: ComposeProject, service: ComposeService) {
		if (!uiState) {
			return;
		}

		const key = serviceLogKey(project.id, service.id);

		if (serviceLogEventSources.has(key)) {
			return;
		}

		const concretePath = actionComposePaths(project, service)[0] || service.composePath || project.path;
		const streamUrl = composeLogsStreamUrl(uiState, project.name || project.id, {
			path: concretePath,
			services: [service.serviceName],
			follow: true,
			tail: '200'
		});
		const source = new EventSource(streamUrl);
		serviceLogEventSources.set(key, source);

		source.addEventListener('message', (event) => {
			try {
				const payload = parseOutputMessage((event as MessageEvent).data);
				const message = String(payload.message ?? '');

				if (!message) {
					return;
				}

				const execStart = parseExecStartMessage(message);

				if (execStart) {
					trackExecCommand(project, service, execStart.execId);
					return;
				}

				const execCompletion = parseExecCompletionMessage(message);

				if (execCompletion) {
					const status = execCompletion.code === 0 ? 'succeeded' : 'failed';
					const trackedEntry = execCommandLogEntries.get(execCompletion.execId);

					if (trackedEntry) {
						markServiceCommandEntry(project, service, status, {
							entryId: trackedEntry.entryId,
							execId: execCompletion.execId
						});
					} else if (trackExecCommand(project, service, execCompletion.execId)) {
						markServiceCommandEntry(project, service, status, {
							execId: execCompletion.execId
						});
					} else {
						pendingExecCompletions.set(execCompletion.execId, execCompletion.code);
					}

					return;
				}

				const stream = String(payload.stream ?? '').trim();
				appendServiceLogEntry(project, service, {
					time: formatBuildTime(String(payload.time ?? '')) || formatBuildTime(new Date().toISOString()),
					source: String(payload.source ?? '').trim() || service.containerName || service.serviceName,
					stream,
					message,
					isError: isErrorLogLine(stream, message)
				});
			} catch {
				// Ignore malformed log messages.
			}
		});

		source.onopen = () => {
			serviceLogStreamErrors = { ...serviceLogStreamErrors, [key]: '' };
		};
		source.onerror = () => {
			serviceLogStreamErrors = {
				...serviceLogStreamErrors,
				[key]: 'Log stream disconnected. Reconnecting…'
			};
		};
	}

	function toggleServiceLogs(project: ComposeProject, service: ComposeService) {
		const key = serviceLogKey(project.id, service.id);
		const nextOpen = !serviceLogOpen(project, service);

		serviceLogPanels = {
			...serviceLogPanels,
			[key]: nextOpen
		};

		if (nextOpen) {
			subscribeToServiceLogs(project, service);
		} else {
			closeServiceLogStream(key);
		}
	}

	function serviceCommandValue(project: ComposeProject, service: ComposeService) {
		return serviceCommandInputs[serviceLogKey(project.id, service.id)] ?? '';
	}

	function setServiceCommandValue(project: ComposeProject, service: ComposeService, value: string) {
		serviceCommandInputs = {
			...serviceCommandInputs,
			[serviceLogKey(project.id, service.id)]: value
		};
	}

	async function runServiceCommand(project: ComposeProject, service: ComposeService) {
		if (!uiState) {
			return;
		}

		const key = serviceLogKey(project.id, service.id);
		const shell = serviceCommandValue(project, service).trim();

		if (!shell || serviceCommandBusy[key]) {
			return;
		}

		serviceCommandBusy = { ...serviceCommandBusy, [key]: true };
		subscribeToServiceLogs(project, service);
		const commandLogId = appendServiceLogEntry(project, service, {
			time: formatBuildTime(new Date().toISOString()),
			source: 'exec',
			stream: 'command',
			message: `$ ${shell}`,
			isError: false,
			isCommand: true,
			commandStatus: 'running'
		});

		try {
			const result = await executeProjectCommand(uiState, project, {
				path: actionComposePaths(project, service)[0] || service.composePath || project.path,
				service: service.serviceName,
				container: service.containerName,
				shell,
				shellExecutable: '/bin/bash',
				startStopped: true,
				tty: false
			});
			const execId = typeof result.execId === 'string' ? result.execId : '';

			if (execId) {
				trackExecCommand(project, service, execId, commandLogId);

				const completionCode = pendingExecCompletions.get(execId);

				if (typeof completionCode === 'number') {
					markServiceCommandEntry(project, service, completionCode === 0 ? 'succeeded' : 'failed', {
						entryId: commandLogId,
						execId
					});
					pendingExecCompletions.delete(execId);
				}
			}

			setServiceCommandValue(project, service, '');
		} catch (error) {
			const message = errorMessage(error, `Failed to execute command in ${service.serviceName}.`);
			markServiceCommandEntry(project, service, 'failed', { entryId: commandLogId });
			reportActionError(project, 'Command failed', message);
		} finally {
			serviceCommandBusy = { ...serviceCommandBusy, [key]: false };
		}
	}

	function setWatchBuildStatus(
		projectId: string,
		status: 'running' | 'succeeded' | 'failed',
		options?: { clear?: boolean }
	) {
		const buildId = watchBuildIds.get(projectId);

		if (!buildId) {
			return;
		}

		if (status === 'running') {
			setActiveBuildTarget(buildId, watchBuildTargets.get(projectId) ?? { projectId });
		} else {
			setActiveBuildTarget(buildId, null);
		}

		setBuildStatus(buildId, status);

		if (options?.clear) {
			watchBuildIds.delete(projectId);
			watchBuildTargets.delete(projectId);
		}
	}

	function projectWatchActive(project: ComposeProject) {
		const watchBuild = currentWatchBuild(project.id);
		return project.watching || watchEventSources.has(project.id) || watchBuild?.status === 'running';
	}

	function watchMessageStartsProgress(message: string) {
		return /rebuilding service|building service|refreshing services/i.test(message);
	}

	function watchMessageFinishesProgress(message: string) {
		return /service\(s\).*successfully built|has been recreated|ready\s+in\s+\d+|watch disabled|syncing service|hmr update/i.test(message);
	}

	function messageFailsProgress(message: string) {
		return /\berror\b|failed|exited with code [1-9]\d*/i.test(message);
	}

	function registerStartedBuild(
		project: ComposeProject,
		startResult: { buildId?: string; buildUrl?: string; watching?: boolean; watchUrl?: string },
		service?: ComposeService
	) {
		let build: ComposeBuild | null = null;

		if (startResult.buildId) {
			build = {
				id: startResult.buildId,
				projectId: project.id,
				projectName: project.name,
				kind: 'build',
				serviceName: service?.serviceName,
				targetName: service?.serviceName ?? project.name,
				status: 'running',
				startedAt: new Date().toISOString(),
				finishedAt: null,
				success: null,
				streamUrl:
					startResult.buildUrl || `/builds/${encodeURIComponent(startResult.buildId)}/stream`
			};

			const existing = currentBuilds().find((entry) => entry.id === build?.id);
			if (existing)
				build = {
					...build,
					startedAt: existing.startedAt,
					serverStartedAt: existing.serverStartedAt,
					status: existing.status,
					success: existing.success,
					finishedAt: existing.finishedAt
				};
			upsertLocalBuild(build);
			setActiveBuildTarget(startResult.buildId, {
				projectId: project.id,
				...(service ? { serviceId: service.id } : {})
			});
			subscribeToBuild(build);
		}

		if (startResult.watching || startResult.watchUrl) {
			setProjectWatching(project.id, true);
			const watchBuildId = ensureWatchBuild(project, service).id;
			subscribeToWatch(project, startResult.watchUrl, watchBuildId);
		}
	}

	async function refreshBuildState() {
		if (!uiState || refreshingBuilds || disposed) return currentBuilds();
		refreshingBuilds = true;
		try {
			const incoming = await loadBuilds(uiState);
			if (disposed) return currentBuilds();
			for (const build of incoming) {
				if (isReplacementBuild(currentBuilds().find((entry) => entry.id === build.id), build)) {
					buildStreamControllers.get(build.id)?.abort();
					buildStreamControllers.delete(build.id);
					capturedBuilds.delete(build.id);
					buildStreamEntries = buildStreamEntries.filter((entry) => entry.buildId !== build.id);
				}
			}
			const nextBuilds = mergeBuilds(currentBuilds(), incoming);
			hydrateBuilds(nextBuilds);
			buildHistoryError = '';
			for (const build of nextBuilds) {
				if (build.status === 'running') {
					const project = visibleProjects.find(
						(entry) => entry.id === build.projectId || entry.name === build.projectName
					);
					setActiveBuildTarget(
						build.id,
						activeBuildTargets[build.id] ?? { projectId: project?.id ?? build.projectId }
					);
				} else {
					setActiveBuildTarget(build.id, null);
				}
				if (build.streamUrl && !capturedBuilds.has(build.id)) subscribeToBuild(build);
			}
			return nextBuilds;
		} catch (error) {
			buildHistoryError = errorMessage(error, 'Build history is unavailable. Retrying…');
			return currentBuilds();
		} finally {
			refreshingBuilds = false;
		}
	}

	function subscribeToBuild(build: ComposeBuild) {
		if (!uiState || disposed || !build.streamUrl || buildStreamControllers.has(build.id)) return;
		const controller = new AbortController();
		buildStreamControllers.set(build.id, controller);
		buildStreamErrors = { ...buildStreamErrors, [build.id]: '' };
		const streamUrl = resolveBuildStreamUrl(uiState, build.streamUrl);
		const toEntries = (messages: OutputMessage[]): BuildStreamEntry[] =>
			messages.map((message, index) => ({
				id: `${build.id}:${index}`,
				buildId: build.id,
				projectId: build.projectId,
				time: formatBuildTime(message.time ?? ''),
				source: message.source || 'Compose',
				stream: message.stream || '',
				message: message.message
			}));
		const replaceOutput = (messages: OutputMessage[]) => {
			buildStreamEntries = [
				...buildStreamEntries.filter((entry) => entry.buildId !== build.id),
				...toEntries(messages)
			];
		};
		const capturedLength = buildStreamEntriesForBuild(build.id).length;
		void (async () => {
			const attempt: OutputMessage[] = [];
			try {
				let messages = await readBuildOutput(streamUrl, controller.signal, (message) => {
					attempt.push(message);
					// Keep previously captured output visible until replay has caught up.
					if (attempt.length > capturedLength) {
						buildStreamEntries.push({
							...toEntries([message])[0],
							id: `${build.id}:${attempt.length - 1}`
						});
					}
					const status = buildCompletion(message);
					if (status) setBuildStatus(build.id, status);
				});
				if (build.status === 'running') {
					// The server can drop live messages for slow subscribers. Once finished,
					// replay its complete stored backlog to recover every retained line.
					messages = await readBuildOutput(streamUrl, controller.signal, () => {});
				}
				if (controller.signal.aborted) return;
				replaceOutput(messages);
				capturedBuilds.add(build.id);
				void refreshBuildState();
			} catch (error) {
				if (!controller.signal.aborted) {
					buildStreamErrors = {
						...buildStreamErrors,
						[build.id]: errorMessage(error, 'Build output is unavailable. Retrying…')
					};
				}
			} finally {
				if (buildStreamControllers.get(build.id) === controller) buildStreamControllers.delete(build.id);
			}
		})();
	}

	function closeWatchStream(projectId: string) {
		const source = watchEventSources.get(projectId);

		if (source) {
			source.close();
			watchEventSources.delete(projectId);
		}

		setWatchBuildStatus(
			projectId,
			currentWatchBuild(projectId)?.status === 'failed' ? 'failed' : 'succeeded',
			{ clear: true }
		);
	}

	function subscribeToWatch(
		project: Pick<ComposeProject, 'id' | 'name'>,
		watchUrl?: string,
		buildId?: string
	) {
		if (!uiState || watchEventSources.has(project.id)) {
			return;
		}

		const streamUrl = resolveBuildStreamUrl(
			uiState,
			watchUrl || `/watch/${encodeURIComponent(project.name || project.id)}`
		);

		if (!streamUrl) {
			return;
		}

		const source = new EventSource(streamUrl);
		watchEventSources.set(project.id, source);
		const watchBuildId = buildId ?? ensureWatchBuild(project).id;

		if (!buildId) {
			setWatchBuildStatus(project.id, 'succeeded');
		}

		source.addEventListener('message', (event) => {
			try {
				const payload = parseOutputMessage((event as MessageEvent).data);
				const payloadProject = String(payload.project ?? '').trim();
				const projectId = !payloadProject || payloadProject === project.name ? project.id : payloadProject;
				const message = String(payload.message ?? '');

				if (!message) {
					return;
				}

				appendBuildStreamEntry(watchBuildId, projectId, payload, 'Watch');

				if (watchMessageStartsProgress(message)) {
					setWatchBuildStatus(project.id, 'running');
				}

				if (messageFailsProgress(message)) {
					setWatchBuildStatus(project.id, 'failed');
				} else if (watchMessageFinishesProgress(message)) {
					setWatchBuildStatus(
						project.id,
						currentWatchBuild(project.id)?.status === 'failed' ? 'failed' : 'succeeded',
						{
							clear: /watch disabled/i.test(message)
						}
					);
				}
			} catch {
				// Ignore malformed watch messages.
			}
		});
		source.onopen = () => {
			buildStreamErrors = { ...buildStreamErrors, [watchBuildId]: '' };
		};
		source.onerror = () => {
			buildStreamErrors = {
				...buildStreamErrors,
				[watchBuildId]: 'Watch output disconnected. Reconnecting…'
			};
		};
	}

	function syncWatchStreams(projects: ComposeProject[]) {
		const watchingProjectIds = new Set(
			projects.filter((project) => project.watching).map((project) => project.id)
		);

		for (const projectId of watchEventSources.keys()) {
			if (!watchingProjectIds.has(projectId)) {
				closeWatchStream(projectId);
			}
		}

		for (const project of projects) {
			if (project.watching) {
				subscribeToWatch(project);
			}
		}
	}

	async function refreshSystemResources() {
		const ui = uiStateCollection.state.get('app');

		if (!ui) {
			return;
		}

		const [nextSystemInfo, nextDiskUsage, nextRuntimeStatus] = await Promise.allSettled([
			loadSystemInfo(ui),
			loadSystemDiskUsage(ui),
			loadRuntimeStatus(ui)
		]);

		if (nextSystemInfo.status === 'fulfilled') {
			systemInfo = nextSystemInfo.value;
		}

		if (nextDiskUsage.status === 'fulfilled') {
			systemDiskUsage = nextDiskUsage.value;
		}

		if (nextRuntimeStatus.status === 'fulfilled') {
			runtimeStatus = nextRuntimeStatus.value;
		}
	}

	async function refreshSelectedResources() {
		const ui = uiStateCollection.state.get('app');
		const project = selectedProject;

		if (!ui || !project) {
			projectResources = null;
			return;
		}

		const service = selectedResourceService;
		const actionPaths = service ? actionComposePaths(project, service) : composeFilePaths(project);
		const path = actionPaths[0] || project.path;

		const request = {
			path,
			...(service ? { services: [service.serviceName] } : {}),
			all: true
		};

		try {
			projectResources = await loadProjectResources(ui, project, {
				...request,
				granularity: 'all'
			});
		} catch {
			try {
				projectResources = await loadProjectResources(ui, project, {
					...request,
					granularity: service ? 'service' : 'project'
				});
			} catch {
				if (!projectResources || (projectResources.project !== project.id && projectResources.project !== project.name)) {
					projectResources = null;
				}
			}
		}
	}

	onMount(() => {
		const handleHashChange = () => {
			pendingHashSelection = parseSelectionHash(window.location.hash);
		};

		handleHashChange();
		void refresh();
		void refreshBuildState();
		void refreshSystemResources();
		void refreshSelectedResources();
		window.addEventListener('hashchange', handleHashChange);

		const intervalId = window.setInterval(() => {
			const currentUi = uiStateCollection.state.get('app');

			// Builds must still be discovered while a blocking /up request is pending.
			void refreshBuildState();

			if (!currentUi || currentUi.autoRefreshPaused || refreshing || busyAction) {
				return;
			}

			void refresh({ silent: true });
			void refreshSystemResources();
			void refreshSelectedResources();
		}, LS_POLL_INTERVAL_MS);

		return () => {
			disposed = true;
			window.removeEventListener('hashchange', handleHashChange);
			window.clearInterval(intervalId);
			for (const source of buildStreamControllers.values()) {
				source.abort();
			}
			buildStreamControllers.clear();
			for (const source of watchEventSources.values()) {
				source.close();
			}
			watchEventSources.clear();
			for (const source of serviceLogEventSources.values()) {
				source.close();
			}
			serviceLogEventSources.clear();
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

	$effect(() => {
		selectedProjectId;
		selectedContainerId;
		serviceQueryEpoch;
		void refreshSelectedResources();
	});

	const visibleProcessSnapshots = $derived(
		selectedContainerId
			? processSnapshots.filter((entry) => entry.id === selectedContainerId)
			: processSnapshots
	);
	const selectedResourceService = $derived(selectedContainer);

	function numberValue(...values: unknown[]) {
		for (const value of values) {
			if (value === null || value === undefined || value === '') {
				continue;
			}

			const number = typeof value === 'number' ? value : Number(value);

			if (Number.isFinite(number)) {
				return number;
			}
		}

		return undefined;
	}

	function parseByteString(value: unknown) {
		if (typeof value === 'number') {
			return Number.isFinite(value) ? value : undefined;
		}

		if (typeof value !== 'string') {
			return undefined;
		}

		const match = value.trim().match(/^([\d.]+)\s*([kmgtp]?i?b?)?$/i);

		if (!match) {
			return numberValue(value);
		}

		const amount = Number(match[1]);

		if (!Number.isFinite(amount)) {
			return undefined;
		}

		const unit = (match[2] || 'b').toLowerCase();
		const multipliers: Record<string, number> = {
			b: 1,
			k: 1024,
			kb: 1024,
			kib: 1024,
			m: 1024 ** 2,
			mb: 1024 ** 2,
			mib: 1024 ** 2,
			g: 1024 ** 3,
			gb: 1024 ** 3,
			gib: 1024 ** 3,
			t: 1024 ** 4,
			tb: 1024 ** 4,
			tib: 1024 ** 4,
			p: 1024 ** 5,
			pb: 1024 ** 5,
			pib: 1024 ** 5
		};

		return amount * (multipliers[unit] ?? 1);
	}

	function nestedValue(source: unknown, path: string) {
		let cursor = source as Record<string, unknown> | undefined;

		for (const part of path.split('.')) {
			if (!cursor || typeof cursor !== 'object') {
				return undefined;
			}

			cursor = cursor[part] as Record<string, unknown> | undefined;
		}

		return cursor as unknown;
	}

	function recordValue(source: unknown, path?: string) {
		const value = path ? nestedValue(source, path) : source;
		return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
	}

	function recordCandidates(source: unknown, ...paths: string[]) {
		const candidates = [recordValue(source), ...paths.map((path) => recordValue(source, path))];
		const seen = new Set<Record<string, unknown>>();

		return candidates.filter((candidate): candidate is Record<string, unknown> => {
			if (!candidate || seen.has(candidate)) {
				return false;
			}

			seen.add(candidate);
			return true;
		});
	}

	function nestedNumberFromCandidates(candidates: Record<string, unknown>[], ...paths: string[]) {
		for (const candidate of candidates) {
			const value = nestedNumber(candidate, ...paths);

			if (value !== undefined) {
				return value;
			}
		}

		return undefined;
	}

	function nestedNumber(source: unknown, ...paths: string[]) {
		for (const path of paths) {
			const cursor = nestedValue(source, path);
			const value = numberValue(cursor) ?? parseByteString(cursor);

			if (value !== undefined) {
				return value;
			}
		}

		return undefined;
	}

	function formatPercent(value: number | undefined) {
		return value === undefined ? '--' : `${Math.max(0, value).toFixed(value >= 10 ? 0 : 1)}%`;
	}

	function formatCores(value: number | undefined) {
		if (value === undefined) {
			return '--';
		}

		return `${Math.max(0, value).toFixed(value >= 10 ? 0 : 2)} cores`;
	}

	function formatBytes(value: number | undefined) {
		if (value === undefined) {
			return 'unknown';
		}

		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let amount = Math.max(0, value);
		let unit = 0;

		while (amount >= 1024 && unit < units.length - 1) {
			amount /= 1024;
			unit += 1;
		}

		return `${amount.toFixed(amount >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
	}

	function resourceMetricTooltip(metric: ResourceMetric) {
		const pressure = resourcePressure(metric.percent);

		if (pressure === 'normal') {
			return metric.tooltip;
		}

		return `${metric.tooltip}\n${pressure === 'critical' ? 'Critical' : 'High'} utilization: ${formatPercent(metric.percent)}`;
	}

	function systemCpuCount() {
		return nestedNumberFromCandidates(
			recordCandidates(systemInfo, 'data', 'system', 'info', 'host'),
			'NCPU',
			'nCPU',
			'cpuCount',
			'cpus',
			'CPUCount',
			'cpu.count',
			'host.cpuCount'
		);
	}

	function systemMemoryBytes() {
		return nestedNumberFromCandidates(
			recordCandidates(systemInfo, 'data', 'system', 'info', 'host'),
			'MemTotal',
			'memTotal',
			'memoryBytes',
			'memoryTotalBytes',
			'totalMemoryBytes',
			'host.memoryBytes',
			'host.memoryTotalBytes'
		);
	}

	function dockerDiskUsedBytes() {
		const candidates = recordCandidates(systemDiskUsage, 'data', 'df', 'diskUsage', 'usage');
		const imagesSize = nestedNumberFromCandidates(candidates, 'LayersSize', 'layersSize');
		const explicit = nestedNumberFromCandidates(
			candidates,
			'usedBytes',
			'UsedBytes',
			'totalUsageBytes',
			'TotalUsageBytes',
			'size',
			'Size',
			'usage.size',
			'usage.usedBytes'
		);

		if (explicit !== undefined) {
			return explicit;
		}

		const lists = [
			...(imagesSize === undefined ? ['Images', 'images'] : []),
			'Containers',
			'containers',
			'Volumes',
			'volumes',
			'BuildCache',
			'buildCache'
		];
		let total = imagesSize ?? 0;

		for (const key of lists) {
			for (const candidate of candidates) {
				const items = candidate[key];

				if (!Array.isArray(items)) {
					continue;
				}

				for (const item of items as Record<string, unknown>[]) {
					total +=
						numberValue(
							item.Size,
							item.size,
							item.SizeRootFs,
							item.sizeRootFs,
							item.Reclaimable,
							item.reclaimable,
							(item.UsageData as Record<string, unknown> | undefined)?.Size,
							(item.usageData as Record<string, unknown> | undefined)?.size
						) ??
						parseByteString(item.Size) ??
						parseByteString(item.size) ??
						parseByteString(item.SizeRootFs) ??
						parseByteString(item.sizeRootFs) ??
						parseByteString(item.Reclaimable) ??
						parseByteString(item.reclaimable) ??
						0;
				}
			}
		}

		return total || undefined;
	}

	function systemDiskTotalBytes() {
		const diskCandidates = recordCandidates(systemDiskUsage, 'data', 'df', 'diskUsage', 'usage');
		const systemCandidates = recordCandidates(systemInfo, 'data', 'system', 'info', 'host');
		const direct = nestedNumberFromCandidates(
			diskCandidates,
			'totalBytes',
			'TotalBytes',
			'diskTotalBytes',
			'DockerRootDirTotalBytes',
			'rootDirTotalBytes',
			'usage.totalBytes',
			'rootDir.totalBytes',
			'rootDir.size',
			'RootDirTotalBytes'
		) ?? nestedNumberFromCandidates(
			systemCandidates,
			'totalBytes',
			'TotalBytes',
			'diskTotalBytes',
			'DockerRootDirTotalBytes',
			'rootDirTotalBytes',
			'usage.totalBytes',
			'rootDir.totalBytes',
			'rootDir.size',
			'RootDirTotalBytes'
		);

		if (direct !== undefined) {
			return direct;
		}

		const driverStatus = systemInfo?.DriverStatus ?? systemInfo?.driverStatus;

		if (Array.isArray(driverStatus)) {
			for (const entry of driverStatus) {
				if (!Array.isArray(entry) || entry.length < 2) {
					continue;
				}

				if (String(entry[0]).toLowerCase().includes('total')) {
					const value = parseByteString(entry[1]);

					if (value !== undefined) {
						return value;
					}
				}
			}
		}

		return undefined;
	}

	function usageCpuPercent(usage: ResourceUsage | undefined, utilization: ResourceUtilization | undefined, limits: ResourceLimits | undefined) {
		if (utilization?.cpuLimitPercent !== undefined) {
			return utilization.cpuLimitPercent;
		}

		const raw = usage?.cpuPercent;
		const limitedCores = limits?.cpuCores;

		if (raw === undefined) {
			return undefined;
		}

		if (limitedCores && limitedCores > 0) {
			return raw / limitedCores;
		}

		const cpus = systemCpuCount();
		return cpus && cpus > 0 ? raw / cpus : raw;
	}

	function usageMemoryPercent(usage: ResourceUsage | undefined, utilization: ResourceUtilization | undefined, limits: ResourceLimits | undefined) {
		if (utilization?.memoryLimitPercent !== undefined) {
			return utilization.memoryLimitPercent;
		}

		if (usage?.memoryPercent !== undefined) {
			return usage.memoryPercent;
		}

		const used = usage?.memoryBytes;
		const limit = limits?.memoryBytes || usage?.memoryLimitBytes || systemMemoryBytes();
		return used !== undefined && limit ? (used / limit) * 100 : undefined;
	}

	function usageHasNumbers(usage: ResourceUsage | undefined) {
		return Boolean(usage && Object.values(usage).some((value) => typeof value === 'number' && Number.isFinite(value)));
	}

	function aggregateResourceUsage(entries: Array<{ usage?: ResourceUsage }> | undefined) {
		if (!entries?.length) {
			return undefined;
		}

		const totals: ResourceUsage = {};
		let seen = false;
		const keys: Array<keyof ResourceUsage> = [
			'cpuPercent',
			'memoryBytes',
			'memoryLimitBytes',
			'networkRxBytes',
			'networkTxBytes',
			'blockReadBytes',
			'blockWriteBytes',
			'pidsCurrent'
		];

		for (const entry of entries) {
			for (const key of keys) {
				const value = entry.usage?.[key];

				if (typeof value === 'number' && Number.isFinite(value)) {
					totals[key] = (totals[key] ?? 0) + value;
					seen = true;
				}
			}
		}

		return seen ? totals : undefined;
	}

	function aggregateResourceLimits(entries: Array<{ limits?: ResourceLimits }> | undefined) {
		if (!entries?.length) {
			return undefined;
		}

		const totals: Record<string, number> = {};
		let seen = false;
		const keys = [
			'memoryBytes',
			'memoryReservationBytes',
			'memorySwapBytes',
			'nanoCpus',
			'cpuCores',
			'pidsLimit'
		] as const;

		for (const entry of entries) {
			for (const key of keys) {
				const value = entry.limits?.[key];

				if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
					totals[key] = (totals[key] ?? 0) + value;
					seen = true;
				}
			}
		}

		return seen ? (totals as ResourceLimits) : undefined;
	}

	function resourceMetrics(
		usage: ResourceUsage | undefined,
		limits: ResourceLimits | undefined,
		utilization: ResourceUtilization | undefined,
		scope: string
	): ResourceMetric[] {
		const cpu = usageCpuPercent(usage, utilization, limits);
		const memory = usageMemoryPercent(usage, utilization, limits);
		const diskBytes = usage ? (usage.blockReadBytes ?? 0) + (usage.blockWriteBytes ?? 0) : undefined;
		const cpuCores = usage?.cpuPercent !== undefined ? usage.cpuPercent / 100 : undefined;
		const memoryLimit = limits?.memoryBytes || usage?.memoryLimitBytes || systemMemoryBytes();

		return [
			{
				label: 'CPU',
				value: formatPercent(cpu),
				hoverValue: formatCores(cpuCores),
				tooltip: `${scope} CPU\n${formatPercent(cpu)}\nRaw: ${formatPercent(usage?.cpuPercent)}\nLimit: ${limits?.cpuCores ? `${limits.cpuCores} cores` : `${systemCpuCount() ?? 'unknown'} VM CPUs`}`,
				percent: cpu
			},
			{
				label: 'MEM',
				value: memory === undefined ? formatBytes(usage?.memoryBytes) : formatPercent(memory),
				hoverValue: `${formatBytes(usage?.memoryBytes)} / ${formatBytes(memoryLimit)}`,
				tooltip: `${scope} memory\n${formatBytes(usage?.memoryBytes)} / ${formatBytes(memoryLimit)}`,
				percent: memory
			},
			{
				label: 'HD',
				value: formatBytes(diskBytes),
				hoverValue: `${formatBytes(usage?.blockReadBytes)} R / ${formatBytes(usage?.blockWriteBytes)} W`,
				tooltip: `${scope} disk I/O\nNo capacity limit configured\nRead ${formatBytes(usage?.blockReadBytes)}\nWrite ${formatBytes(usage?.blockWriteBytes)}`
			}
		];
	}

	function vmMetrics(): ResourceMetric[] {
		const systemCandidates = recordCandidates(systemInfo, 'data', 'system', 'info', 'host');
		const cpu = nestedNumberFromCandidates(systemCandidates, 'cpuPercent', 'CPUPercent', 'usage.cpuPercent', 'host.cpuPercent');
		const cpuCount = systemCpuCount();
		const containerMemoryUsed = nestedNumberFromCandidates(
			systemCandidates,
			'memoryUsedBytes',
			'MemUsed',
			'usage.memoryBytes',
			'host.memoryUsedBytes'
		);
		const memoryTotal = runtimeStatus?.memoryTotalBytes ?? systemMemoryBytes();
		const memoryUsed =
			runtimeStatus?.memoryAvailableBytes !== undefined && memoryTotal !== undefined
				? Math.max(0, memoryTotal - runtimeStatus.memoryAvailableBytes)
				: containerMemoryUsed;
		const diskUsed = dockerDiskUsedBytes();
		const diskTotal = systemDiskTotalBytes();
		const memory =
			memoryUsed !== undefined && memoryTotal ? (memoryUsed / memoryTotal) * 100 : undefined;
		const disk = diskUsed !== undefined && diskTotal ? (diskUsed / diskTotal) * 100 : undefined;

		return [
			{
				label: 'CPU',
				value: formatPercent(cpu),
				hoverValue: cpuCount !== undefined ? `${cpuCount} CPU${cpuCount === 1 ? '' : 's'}` : formatPercent(cpu),
				tooltip: `All containers in the VM\n${cpu === undefined ? 'Live CPU usage unavailable' : formatPercent(cpu)} CPU\n${cpuCount ?? 'unknown'} VM CPUs`,
				percent: cpu
			},
			{
				label: 'MEM',
				value:
					memory === undefined ? formatBytes(memoryUsed ?? memoryTotal) : formatPercent(memory),
				hoverValue: `${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)}`,
				tooltip: runtimeStatus?.memoryAvailableBytes !== undefined
					? `Container VM memory\n${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)}`
					: `All containers in the VM\n${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)} memory`,
				percent: memory
			},
			{
				label: 'HD',
				value: disk === undefined ? formatBytes(diskUsed ?? diskTotal) : formatPercent(disk),
				hoverValue: `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`,
				tooltip: `Docker data in the VM\n${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`,
				percent: disk
			}
		];
	}

	function macMetrics(): ResourceMetric[] {
		const resources = runtimeStatus?.hostResources;
		const memory =
			resources?.memoryUsedBytes !== undefined && resources.memoryTotalBytes
				? (resources.memoryUsedBytes / resources.memoryTotalBytes) * 100
				: undefined;
		const disk =
			resources?.diskUsedBytes !== undefined && resources.diskTotalBytes
				? (resources.diskUsedBytes / resources.diskTotalBytes) * 100
				: undefined;

		return [
			{
				label: 'CPU',
				value: formatPercent(resources?.cpuPercent),
				hoverValue: resources ? `${resources.cpuCount} CPU${resources.cpuCount === 1 ? '' : 's'}` : '--',
				tooltip: `Mac CPU\n${formatPercent(resources?.cpuPercent)}\n${resources?.cpuCount ?? 'unknown'} CPUs`,
				percent: resources?.cpuPercent
			},
			{
				label: 'MEM',
				value:
					memory === undefined
						? formatBytes(resources?.memoryUsedBytes ?? resources?.memoryTotalBytes)
						: formatPercent(memory),
				hoverValue: `${formatBytes(resources?.memoryUsedBytes)} / ${formatBytes(resources?.memoryTotalBytes)}`,
				tooltip: `Mac memory\n${formatBytes(resources?.memoryUsedBytes)} / ${formatBytes(resources?.memoryTotalBytes)}`,
				percent: memory
			},
			{
				label: 'HD',
				value:
					disk === undefined
						? formatBytes(resources?.diskUsedBytes ?? resources?.diskTotalBytes)
						: formatPercent(disk),
				hoverValue: `${formatBytes(resources?.diskUsedBytes)} / ${formatBytes(resources?.diskTotalBytes)}`,
				tooltip: `Mac disk\n${formatBytes(resources?.diskUsedBytes)} / ${formatBytes(resources?.diskTotalBytes)}`,
				percent: disk
			}
		];
	}

	function selectedResourceMetrics() {
		if (!selectedProject) {
			return [];
		}

		if (!projectResources) {
			return resourceMetrics(undefined, undefined, undefined, selectedProject.name);
		}

		if (selectedResourceService) {
			const container = projectResources.containers?.find(
				(entry) =>
					entry.id === selectedResourceService.id ||
					entry.name === selectedResourceService.containerName ||
					entry.service === selectedResourceService.serviceName
			);
			const service = projectResources.services?.find((entry) => entry.name === selectedResourceService.serviceName);
			const usage = container?.usage ?? service?.usage;
			const limits = container?.limits ?? service?.limits;
			const utilization = container?.utilization ?? service?.utilization;

			return resourceMetrics(usage, limits, utilization, selectedResourceService.serviceName);
		}

		const summaryUsage = projectResources.projectSummary?.usage;
		const summaryLimits = projectResources.projectSummary?.limits;
		const usage = usageHasNumbers(summaryUsage)
			? summaryUsage
			: aggregateResourceUsage(projectResources.containers) ?? aggregateResourceUsage(projectResources.services);
		const limits =
			summaryLimits ??
			aggregateResourceLimits(projectResources.containers) ??
			aggregateResourceLimits(projectResources.services);

		return resourceMetrics(
			usage,
			limits,
			projectResources.projectSummary?.utilization,
			selectedProject.name
		);
	}

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

	function processPid(entry: ComposeProcessSnapshot, process: string[]) {
		const pidIndex = entry.titles.findIndex((title) => title.toLowerCase() === 'pid');
		const pid = pidIndex >= 0 ? Number(process[pidIndex]) : NaN;
		return Number.isFinite(pid) && pid > 0 ? pid : undefined;
	}

	function serviceForProcess(entry: ComposeProcessSnapshot) {
		return selectedServices.find(
			(service) =>
				service.id === entry.containerId ||
				service.containerName === entry.containerName ||
				service.serviceName === entry.serviceName
		);
	}

	async function killProcess(project: ComposeProject | undefined, entry: ComposeProcessSnapshot, process: string[], hard: boolean) {
		if (!project || !uiState) {
			return;
		}

		const pid = processPid(entry, process);
		const service = serviceForProcess(entry);

		if (!pid) {
			reportActionError(project, 'Kill failed', 'No PID column found for this process.');
			return;
		}

		try {
			await killProjectProcess(uiState, project, {
				path: service ? actionComposePaths(project, service)[0] || service.composePath || project.path : project.path,
				container: entry.containerId || entry.containerName,
				service: service?.serviceName || entry.serviceName,
				pid,
				signal: hard ? 'SIGKILL' : 'SIGTERM',
				hard
			});
			await loadProjectProcesses(uiState, { id: project.id }).then((entries) => {
				processSnapshots = entries;
			});
			appendLog(project.id, 'ok', `${hard ? 'Hard killed' : 'Killed'} PID ${pid}.`);
		} catch (error) {
			reportActionError(project, hard ? 'Hard kill failed' : 'Kill failed', errorMessage(error, `Failed to kill PID ${pid}.`));
		}
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
		if (latestBuildFailure(builds, project)) return 'Build failed';
		const matches = [...project.statusLabel.matchAll(/([a-z-]+)(?:\((\d+)\))?/gi)];

		if (matches.length !== 1) {
			return project.statusLabel;
		}

		const label = matches[0]?.[1]?.trim();
		return label || project.statusLabel;
	}

	function shouldShowProjectRowStatus(project: ComposeProject) {
		if (projectPendingStatusLabel(project) || latestBuildFailure(builds, project)) {
			return true;
		}

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
		return `${project.name}\n${projectDisplayStatusLabel(project)}`;
	}

	function projectIconTone(project: ComposeProject) {
		if (latestBuildFailure(builds, project) && !projectStartButtonSpinning(project))
			return 'project-icon-exited';
		const aggregateState = projectAggregateState(project);
		const projectServices = sidebarServices.filter((service) => service.projectId === project.id);

		if (aggregateState === 'running') {
			return 'project-icon-running';
		}

		if (aggregateState === 'paused') {
			return 'project-icon-paused';
		}

		if (aggregateState === 'uncreated') {
			return 'project-icon-uncreated';
		}

		if (
			aggregateState === 'exited' &&
			areProjectServicesStoppedWithoutError(projectServices)
		) {
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

	function dismissToast(id: string) {
		toasts = toasts.filter((toast) => toast.id !== id);
	}

	function showToast(level: Toast['level'], title: string, message: string) {
		const id = `${Date.now()}:${toastSequence++}`;
		toasts = [...toasts.slice(-3), { id, level, title, message }];
		setTimeout(() => dismissToast(id), 8000);
	}

	function reportActionError(project: ComposeProject, title: string, message: string) {
		setConnectionState('error', message);
		appendLog(project.id, 'error', message);
		showToast('error', title, message);
	}

	function wait(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function projectServiceSnapshot(projectId: string, serviceNames?: string[], serviceId?: string) {
		return [...servicesCollection.state.values()].filter((service) => {
			if (service.projectId !== projectId) {
				return false;
			}

			if (serviceId && service.id !== serviceId) {
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
		serviceNames?: string[],
		serviceId?: string
	) {
		for (let attempt = 0; attempt < ACTION_SETTLE_ATTEMPTS; attempt += 1) {
			invalidateProjectServices(projectId);
			await reloadProjectServices([projectId]);
			serviceQueryEpoch += 1;

			const services = projectServiceSnapshot(projectId, serviceNames, serviceId);

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
			setConnectionState('connecting', 'Connecting to the local Compose service.');
		}

		try {
			await checkHealth(uiState);
			const result = await refreshProjectsFromServer(uiState);
			hydrateProjects(result.projects, result.services);
			syncWatchStreams(result.projects);
			invalidateProjectServices();

			const serviceProjectIds = [
				...new Set([...expandedProjectIdList, selectedProjectId].filter(Boolean))
			];

			if (serviceProjectIds.length) {
				await reloadProjectServices(serviceProjectIds);
				serviceQueryEpoch += 1;
			}

			if (!options?.silent || uiState.status !== 'connected') {
				setConnectionState('connected', 'Connected and synchronized.');
			}

		} catch (error) {
			const message = errorMessage(error, 'Server unavailable');
			setConnectionState('error', `Local Compose service unavailable. ${message}`);

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
			serviceId?: string;
			settleState?: 'running' | 'paused' | 'stopped';
		}
	) {
		await refresh();

		if (options?.settleState) {
			await settleProjectServices(
				project.id,
				options.settleState,
				options.serviceNames,
				options.serviceId
			);
		} else {
			invalidateProjectServices(project.id);
			await reloadProjectServices([project.id]);
			serviceQueryEpoch += 1;
		}

		await refreshBuildState();
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
			const actionPaths = actionComposePaths(project, service);
			if (!actionPaths.length) {
				throw new Error(`No compose file path available for ${service?.serviceName ?? project.name}.`);
			}

			if (shouldStop) {
				for (const path of actionPaths) {
					await stopServices(uiState, actionTarget(project, path), serviceNames);
				}
				await syncAfterAction(project, `Stopped ${service?.serviceName ?? project.name}.`, {
					serviceNames,
					serviceId: service?.id,
					settleState: 'stopped'
				});
				setConnectionState('connected', `Stopped ${service?.serviceName ?? project.name}.`);
			} else if (service && service.state === 'uncreated') {
				const startResult = await startProject(
					uiState,
					actionPaths[0],
					project.watching,
					serviceNames
				);
				registerStartedBuild(project, startResult, service);
				await syncAfterAction(project, `Started ${service.serviceName} in ${project.name} via /up.`, {
					serviceNames,
					serviceId: service.id,
					settleState: 'running'
				});
				setConnectionState('connected', `Started ${service.serviceName}.`);
			} else if (service) {
				await startContainer(uiState, actionTarget(project, actionPaths[0]), service.containerId);
				await syncAfterAction(
					project,
					`Started container ${service.containerName} in ${project.name}.`,
					{
						serviceNames,
						serviceId: service.id,
						settleState: 'running'
					}
				);
				setConnectionState('connected', `Started ${service.serviceName}.`);
			} else if (project.state === 'uncreated') {
				for (const path of actionPaths) {
					const startResult = await startProject(uiState, path, project.watching);
					registerStartedBuild(project, startResult);
				}
				await syncAfterAction(project, `Started ${project.name} via /up.`, {
					settleState: 'running'
				});
				setConnectionState('connected', `Started ${project.name}.`);
			} else {
				for (const path of actionPaths) {
					const startResult = await startProject(uiState, path, project.watching, undefined, true);
					registerStartedBuild(project, startResult);
				}
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
			reportActionError(project, shouldStop ? 'Stop failed' : 'Start failed', message);
		} finally {
			busyAction = null;
			void refreshBuildState();
		}
	}

	async function handleStartWithoutRebuild(project = selectedProject, service?: ComposeService) {
		if (!project || !uiState || busyAction) {
			return;
		}

		const serviceNames = service ? [service.serviceName] : undefined;
		busyAction = `up-no-build:${project.id}:${service?.id ?? 'project'}`;

		try {
			const actionPaths = actionComposePaths(project, service);
			if (!actionPaths.length) {
				throw new Error(`No compose file path available for ${service?.serviceName ?? project.name}.`);
			}

			for (const path of actionPaths) {
				await startProject(uiState, path, project.watching, serviceNames, false);
			}
			await syncAfterAction(
				project,
				`Started ${service?.serviceName ?? project.name} without rebuilding.`,
				{
					serviceNames,
					serviceId: service?.id,
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
			reportActionError(project, 'Start failed', message);
		} finally {
			busyAction = null;
			void refreshBuildState();
		}
	}

	async function handleRestart(project = selectedProject, service?: ComposeService) {
		if (!project || !uiState || busyAction) {
			return;
		}

		const serviceNames = service ? [service.serviceName] : undefined;
		const targetName = service?.serviceName ?? project.name;
		const keepWatching = projectWatchActive(project);
		busyAction = `restart:${project.id}:${service?.id ?? 'project'}`;

		try {
			const actionPaths = actionComposePaths(project, service);
			if (!actionPaths.length) {
				throw new Error(`No compose file path available for ${targetName}.`);
			}

			for (const path of actionPaths) {
				const startResult = await startProject(
					uiState,
					path,
					keepWatching,
					serviceNames,
					true
				);
				registerStartedBuild(project, startResult, service);
			}
			await syncAfterAction(project, `Recreated ${targetName} via /up ${keepWatching ? '--watch ' : ''}--build.`, {
				serviceNames,
				serviceId: service?.id,
				settleState: 'running'
			});
			setConnectionState('connected', `Restarted ${targetName}.`);
		} catch (error) {
			const message = errorMessage(error, `Failed to restart ${targetName}.`);
			reportActionError(project, 'Restart failed', message);
		} finally {
			busyAction = null;
			void refreshBuildState();
		}
	}

	async function handleRemove(project = selectedProject, service?: ComposeService) {
		if (!project || !uiState || busyAction) {
			return;
		}

		const targetName = service?.serviceName ?? project.name;
		const confirmed = window.confirm(
			`Remove ${service ? `service ${targetName}` : `project ${targetName}`} containers?`
		);

		if (!confirmed) {
			return;
		}

		const serviceNames = service ? [service.serviceName] : undefined;
		busyAction = `remove:${project.id}:${service?.id ?? 'project'}`;

		try {
			const actionPaths = actionComposePaths(project, service);
			if (!actionPaths.length) {
				throw new Error(`No compose file path available for ${targetName}.`);
			}

			for (const path of actionPaths) {
				await removeServices(uiState, actionTarget(project, path), serviceNames);
			}

			await syncAfterAction(project, `Removed ${targetName}.`, {
				serviceNames,
				serviceId: service?.id
			});
			setConnectionState('connected', `Removed ${targetName}.`);
		} catch (error) {
			const message = errorMessage(error, `Failed to remove ${targetName}.`);
			reportActionError(project, 'Remove failed', message);
		} finally {
			busyAction = null;
			void refreshBuildState();
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
			const actionPaths = actionComposePaths(project, service);
			if (!actionPaths.length) {
				throw new Error(`No compose file path available for ${service?.serviceName ?? project.name}.`);
			}

			if (isUnpause) {
				for (const path of actionPaths) {
					await unpauseServices(uiState, actionTarget(project, path), serviceNames);
				}
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
				for (const path of actionPaths) {
					await pauseServices(uiState, actionTarget(project, path), serviceNames);
				}
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
			reportActionError(project, isUnpause ? 'Resume failed' : 'Pause failed', message);
		} finally {
			busyAction = null;
			void refreshBuildState();
		}
	}

	async function handleWatchingToggle(project = selectedProject, service?: ComposeService) {
		if (!project || !uiState || busyAction) {
			return;
		}

		const nextWatching = !project.watching;
		const serviceNames = service ? [service.serviceName] : undefined;
		busyAction = `watching:${project.id}:${service?.id ?? 'project'}`;

		try {
			const actionPaths = actionComposePaths(project, service);
			if (!actionPaths.length) {
				throw new Error(`No compose file path available for ${service?.serviceName ?? project.name}.`);
			}

			if (nextWatching) {
				for (const path of actionPaths) {
					const startResult = await startProject(uiState, path, nextWatching, serviceNames, true);
					registerStartedBuild(project, startResult, service);
				}
				appendLog(project.id, 'ok', `Started ${service?.serviceName ?? project.name} with watch mode.`);
			} else {
				for (const path of actionPaths) {
					await startProject(uiState, path, nextWatching, serviceNames, true);
				}
				closeWatchStream(project.id);
				appendLog(project.id, 'info', `Started ${service?.serviceName ?? project.name} without watch mode.`);
			}

			setProjectWatching(project.id, nextWatching);
			await refresh({ silent: true });

			if (nextWatching) {
				await settleProjectServices(project.id, 'running', serviceNames);
				setWatchBuildStatus(project.id, 'succeeded');
			}

			clearActiveTargets(project.id, service?.id);
			setConnectionState(
				'connected',
				`${nextWatching ? 'Watching' : 'Stopped watching'} ${service?.serviceName ?? project.name}.`
			);
		} catch (error) {
			const message = errorMessage(
				error,
				`${nextWatching ? 'Failed to start watching' : 'Failed to stop watching'} ${service?.serviceName ?? project.name}.`
			);
			reportActionError(project, nextWatching ? 'Watch failed' : 'Watch stop failed', message);
		} finally {
			busyAction = null;
			void refreshBuildState();
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

		items.push({
			label: 'Remove',
			action: () => void handleRemove(project),
			danger: true
		});

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
				action: () => void handleWatchingToggle(project, service)
			});
		}

		if (project.watching) {
			items.push({
				label: 'Stop watching',
				action: () => void handleWatchingToggle(project, service)
			});
		}

		if (canStartWithoutRebuild(project, service)) {
			items.push({
				label: 'Start without rebuilding',
				action: () => void handleStartWithoutRebuild(project, service)
			});
		}

		items.push({
			label: 'Remove',
			action: () => void handleRemove(project, service),
			danger: true
		});

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

<svelte:window onkeydown={handleGlobalKeydown} />

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
					<option value="status">by status!</option>
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
											name={projectStartButtonSpinning(project)
												? 'refresh'
												: latestBuildFailure(builds, project)
													? 'warning'
													: 'container'}
											size={14}
											class={projectIconTone(project)}
											spinning={projectStartButtonSpinning(project)}
										/>
										{project.name}
									</span>
									{#if shouldShowProjectRowStatus(project)}
										<span class="project-status">{projectPendingStatusLabel(project) || projectRowStatusLabel(project)}</span>
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
											<Icon
												name={busyAction === `stop:${project.id}:project` ? 'refresh' : projectCanStop(project) ? 'stop' : 'play'}
												size={13}
												spinning={busyAction === `stop:${project.id}:project`}
											/>
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
										<Icon
											name={busyAction === `watching:${project.id}:project` ? 'refresh' : project.watching ? 'eye-off' : 'eye'}
											size={13}
											spinning={busyAction === `watching:${project.id}:project`}
										/>
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
								{builds}
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
			<div class="resource-strip" aria-label="Resource usage">
				{#if runtimeStatus?.hostResources}
					<div class="resource-group">
						<span class="resource-group-label">Mac</span>
						{#each macMetrics() as metric (`mac-${metric.label}`)}
							<span
								class="resource-chip"
								data-pressure={resourcePressure(metric.percent)}
								data-tooltip={resourceMetricTooltip(metric)}
							>
								<span>{metric.label}</span>
								<strong class="metric-value-default">{metric.value}</strong>
								<strong class="metric-value-hover">{metric.hoverValue}</strong>
							</span>
						{/each}
					</div>
				{/if}
				<div class="resource-group">
					<span class="resource-group-label">VM</span>
					{#each vmMetrics() as metric (`vm-${metric.label}`)}
						<span
							class="resource-chip"
							data-pressure={resourcePressure(metric.percent)}
							data-tooltip={resourceMetricTooltip(metric)}
						>
							<span>{metric.label}</span>
							<strong class="metric-value-default">{metric.value}</strong>
							<strong class="metric-value-hover">{metric.hoverValue}</strong>
						</span>
					{/each}
				</div>
				{#if selectedProject}
					<div class="resource-group">
						<span class="resource-group-label">{selectedResourceService ? 'Service' : 'Project'}</span>
						{#each selectedResourceMetrics() as metric (`selected-${metric.label}`)}
							<span
								class="resource-chip"
								data-pressure={resourcePressure(metric.percent)}
								data-tooltip={resourceMetricTooltip(metric)}
							>
								<span>{metric.label}</span>
								<strong class="metric-value-default">{metric.value}</strong>
								<strong class="metric-value-hover">{metric.hoverValue}</strong>
							</span>
						{/each}
					</div>
				{/if}
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
						<span class={`pill ${projectDisplayChipClass(selectedProject)}`}>
							{projectDisplayStatusLabel(selectedProject)}
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
			</section>

			<section class="card container-card">
				<div class="card-header card-header-compact">
					<p class="eyebrow">Containers</p>
				</div>

				{#if selectedProject && selectedServices.length}
					<div class="compact-list">
						{#each selectedServices as service (service.id)}
							<div class="service-log-item">
								<div class="service-log-header">
									<button
										class="compact-row service-log-button"
										class:service-log-button-linked={service.state === 'running'}
										type="button"
										aria-pressed={serviceLogOpen(selectedProject, service)}
										onmousedown={(event) => {
											if (!isPrimaryMouse(event)) return;
											toggleServiceLogs(selectedProject, service);
										}}
									>
										<div>
											<div class="row-title">
												<span class="config-chevron">
													<Icon name="chevron" size={12} rotated={serviceLogOpen(selectedProject, service)} />
												</span>
												{service.serviceName}
											</div>
											<div class="row-subtitle">{service.containerName}</div>
										</div>
										<div class="row-tail">
											{#if serviceLogErrorCount(selectedProject, service)}
												<span class="state-chip state-chip-exited">
													{serviceLogErrorCount(selectedProject, service)} errors
												</span>
											{/if}
											<span class={`state-chip ${serviceDisplayChipClass(selectedProject, service)}`}>
												{serviceDisplayStateLabel(selectedProject, service)}
											</span>
											<span>{serviceDisplayStatusText(selectedProject, service)}</span>
											{#if service.health && !servicePendingStatusLabel(selectedProject, service)}
												<span class="health-tag">({service.health})</span>
											{/if}
										</div>
									</button>

									{#if service.state === 'running'}
										<a
											class="service-overview-link"
											href={composeServiceUrl(service)}
											target="_blank"
											rel="external noreferrer"
											aria-label={`Open ${service.serviceName} in browser`}
										>
											<Icon name="link" size={13} />
											<span>Open</span>
										</a>
									{/if}
								</div>

								{#if serviceLogOpen(selectedProject, service)}
									{#if serviceLogStreamErrors[serviceLogKey(selectedProject.id, service.id)]}
										<div class="config-output-state output-error" role="status">
											{serviceLogStreamErrors[serviceLogKey(selectedProject.id, service.id)]}
										</div>
									{/if}
									{@const entries = serviceLogsFor(selectedProject, service)}
									<div class="service-log-output">
										{#if entries.length}
											<div class="service-log-list">
												{#each entries as entry (entry.id)}
													<div
														class:command-log-row={entry.isCommand}
														class:error-log-row={entry.isError}
														class="service-log-row"
													>
														<span class="log-time">{entry.time}</span>
														<span class="build-stream-source">{entry.source}</span>
														{#if entry.isCommand && entry.commandStatus && entry.commandStatus !== 'running'}
															<span
																class={`command-status command-status-${entry.commandStatus}`}
																aria-label={entry.commandStatus === 'succeeded' ? 'Command succeeded' : 'Command failed'}
															>
																{entry.commandStatus === 'succeeded' ? '✓' : '!'}
															</span>
														{/if}
														<span class="log-message">{entry.message}</span>
													</div>
												{/each}
											</div>
										{:else}
											<div class="config-output-state">
												Waiting for logs…
											</div>
										{/if}
										<form
											class="command-form"
											onsubmit={(event) => {
												event.preventDefault();
												void runServiceCommand(selectedProject, service);
											}}
										>
											<input
												type="text"
												value={serviceCommandValue(selectedProject, service)}
												oninput={(event) =>
													setServiceCommandValue(selectedProject, service, event.currentTarget.value)}
												placeholder="Run shell command"
												aria-label={`Run command in ${service.serviceName}`}
											/>
											<button
												type="button"
												disabled={!entries.length}
												onmousedown={(event) => {
													if (!isPrimaryMouse(event)) return;
													clearServiceLogs(selectedProject, service);
												}}
											>
												Clear
											</button>
											<button
												type="submit"
												disabled={!serviceCommandValue(selectedProject, service).trim() || serviceCommandBusy[serviceLogKey(selectedProject.id, service.id)]}
											>
												{serviceCommandBusy[serviceLogKey(selectedProject.id, service.id)] ? 'Starting' : 'Run'}
											</button>
										</form>
									</div>
								{/if}
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
								<button
									class="process-heading"
									type="button"
									aria-pressed={processPanelOpen(entry.id)}
									onmousedown={(event) => {
										if (!isPrimaryMouse(event)) return;
										toggleProcessPanel(entry.id);
									}}
								>
									<div class="tooltip-anchor" data-tooltip={entry.containerName}>
										<div class="row-title">
											<span class="config-chevron">
												<Icon name="chevron" size={12} rotated={processPanelOpen(entry.id)} />
											</span>
											{entry.serviceName}
										</div>
									</div>
									<div class="row-tail">
										<span class="process-replica">
											{entry.processes.length} {entry.processes.length === 1 ? 'process' : 'processes'}
										</span>
										{#if entry.replica}
											<span class="process-replica">#{entry.replica}</span>
										{/if}
									</div>
								</button>

								{#if processPanelOpen(entry.id)}
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

														<div class="process-actions">
															{#if command.commandPath}
																<div class="command-path" data-tooltip={command.commandPath}>
																	{command.commandPath}
																</div>
															{/if}
															{#if selectedProject && processPid(entry, process)}
																<button
																	class="process-kill-button"
																	type="button"
																	onmousedown={(event) => {
																		if (!isPrimaryMouse(event)) return;
																		void killProcess(selectedProject, entry, process, false);
																	}}
																>
																	Kill
																</button>
																<button
																	class="process-kill-button danger-kill"
																	type="button"
																	onmousedown={(event) => {
																		if (!isPrimaryMouse(event)) return;
																		void killProcess(selectedProject, entry, process, true);
																	}}
																>
																	Hard kill
																</button>
															{/if}
														</div>
													</div>
												{/if}

												<div class="process-meta">
													{#each processFields(entry, process) as field (field.label)}
														<div class="process-meta-item">
															<span class="process-meta-label">{field.label}</span>
															<strong>{field.value}</strong>
														</div>
													{/each}
												</div>
											</div>
										{/each}
									</div>
								{/if}
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

				{#if buildHistoryError}
					<div class="config-output-state output-error" role="alert">
						{buildHistoryError}
						<button type="button" onclick={() => void refreshBuildState()}>Retry</button>
					</div>
				{/if}

				{#if selectedProjectBuilds.length}
					<div class="build-list">
						{#each selectedProjectBuilds as build (build.id)}
							{@const entries = buildStreamEntriesForBuild(build.id)}
							<div class="build-item">
								<button
									class="build-button"
									type="button"
									aria-expanded={buildPanelOpen(build.id)}
									onclick={() => toggleBuildPanel(build.id)}
								>
									<span class="build-copy">
										<span class="row-title">
											<span class="config-chevron">
												<Icon name="chevron" size={12} rotated={buildPanelOpen(build.id)} />
											</span>
											{buildRowTitle(build)}
											{#if build.status === 'running'}
												<Icon name="refresh" size={12} spinning={true} />
											{:else if build.status === 'failed'}
												<span class="output-error" aria-label="Build failed"
													><Icon name="warning" size={14} /></span
												>
											{/if}
										</span>
									</span>
									<span class="row-tail">
										<span class={`state-chip ${buildStateChipClass(build)}`}>
											{buildStatusLabel(build)}
										</span>
										<span>{formatBuildTime(build.finishedAt ?? build.startedAt)}</span>
									</span>
								</button>

								{#if buildPanelOpen(build.id)}
									<div class="build-output" use:keepBuildOutputPinned>
										{#if buildStreamErrors[build.id]}
											<div class="config-output-state output-error" role="alert">
												{buildStreamErrors[build.id]}
												{#if build.streamUrl}<button
														type="button"
														onclick={() => subscribeToBuild(build)}>Retry output</button
													>{/if}
											</div>
										{/if}
										{#if entries.length}
											<div class="build-stream-list">
												{#each entries as entry (entry.id)}
													<div
														class="build-stream-row"
														class:output-error={isErrorLogLine(entry.stream, entry.message)}
													>
														<span class="log-time">{entry.time}</span>
														<span class="build-stream-source">{entry.source}</span>
														<span class="log-message">{entry.message}</span>
													</div>
												{/each}
											</div>
										{:else}
											<div class="config-output-state">
												{build.streamUrl ? 'Loading build output…' : 'Waiting for watch output…'}
											</div>
										{/if}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{:else}
					<div class="empty-state">No builds yet.</div>
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

	{#if toasts.length}
		<div class="toast-stack" aria-live="assertive" aria-relevant="additions">
			{#each toasts as toast (toast.id)}
				<div class={`toast toast-${toast.level}`} role={toast.level === 'error' ? 'alert' : 'status'}>
					<div class="toast-copy">
						<strong>{toast.title}</strong>
						<span>{toast.message}</span>
					</div>
					<button
						class="toast-dismiss"
						type="button"
						aria-label={`Dismiss ${toast.title}`}
						onmousedown={() => dismissToast(toast.id)}
					>
						X
					</button>
				</div>
			{/each}
		</div>
	{/if}

	{#if contextMenu}
		<button
			class="context-menu-backdrop"
			type="button"
			aria-label="Close context menu"
			onmousedown={closeContextMenu}
			oncontextmenu={closeContextMenu}
		></button>

		<div class="context-menu" style={`left:${contextMenu.x}px;top:${contextMenu.y}px;`}>
			{#each contextMenu.items as item (item.label)}
				<button
					class="context-menu-item"
					class:context-menu-danger={item.danger}
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
		left: 0;
		width: 1px;
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
	.service-log-button,
	.process-heading,
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
		overflow-x: hidden;
		overflow-y: auto;
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

	.project-row .toggle {
		height: 1.25rem;
		width: 1.25rem;
		justify-self: center;
		border-radius: 999px;
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
		color: #1d9bf0;
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
		align-items: center;
		min-width: 0;
		gap: 0.35rem;
		font-weight: 600;
		color: var(--app-text);
	}

	.config-chevron {
		display: inline-grid;
		flex: none;
		width: 1rem;
		height: 1rem;
		place-items: center;
		line-height: 1;
	}

	.config-chevron :global(svg) {
		display: block;
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

	.context-menu-danger {
		color: #ffaaa6;
	}

	.context-menu-danger:hover {
		background: rgba(126, 74, 74, 0.22);
		color: #ffc0bf;
	}

	.context-menu-item:disabled {
		cursor: default;
		opacity: 0.42;
	}

	.context-menu-item:disabled:hover {
		background: transparent;
		color: var(--app-text);
	}

	.toast-stack {
		position: absolute;
		right: 1rem;
		top: 1rem;
		z-index: 60;
		display: flex;
		width: min(24rem, calc(100vw - 2rem));
		flex-direction: column;
		gap: 0.5rem;
		pointer-events: none;
	}

	.toast {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.8rem;
		border: 1px solid var(--app-border-strong);
		border-radius: 0.75rem;
		background: var(--app-surface-raised);
		padding: 0.72rem 0.78rem;
		box-shadow: 0 18px 42px rgba(0, 0, 0, 0.56);
		pointer-events: auto;
	}

	.toast-error {
		border-color: rgba(226, 91, 91, 0.48);
		background: #120606;
	}

	.toast-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.24rem;
	}

	.toast-copy strong {
		color: #ffc0bf;
		font-size: 0.78rem;
	}

	.toast-copy span {
		color: var(--app-text);
		font-size: 0.76rem;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.toast-dismiss {
		flex: none;
		width: 1.35rem;
		height: 1.35rem;
		border: 0;
		border-radius: 0.38rem;
		background: transparent;
		color: var(--app-text-muted);
		font-size: 0.72rem;
		font-weight: 700;
		cursor: pointer;
	}

	.toast-dismiss:hover {
		background: var(--app-control-hover);
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

	.resource-strip {
		display: flex;
		min-width: 0;
		flex: 1 1 auto;
		align-items: center;
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: 0.55rem 1rem;
		overflow: visible;
	}

	.resource-group {
		display: inline-flex;
		min-width: 0;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.28rem 0.4rem;
	}

	.resource-group-label {
		color: var(--app-text-subtle);
		font-size: 0.64rem;
		font-weight: 700;
		text-transform: uppercase;
		margin-right: 0.15rem;
	}

	.resource-chip {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 0.22rem;
		border-radius: 999px;
		background: var(--app-control);
		padding: 0.2rem 0.42rem;
		color: var(--app-text-muted);
		font-size: 0.68rem;
		font-weight: 700;
		white-space: nowrap;
	}

	.resource-chip strong {
		color: var(--app-text);
		font-size: 0.7rem;
	}

	.resource-chip[data-pressure='warning']::before,
	.resource-chip[data-pressure='critical']::before {
		content: '';
		width: 0.36rem;
		height: 0.36rem;
		flex: none;
		border-radius: 999px;
	}

	.resource-chip[data-pressure='warning']::before {
		background: #d9a441;
		box-shadow: 0 0 0 0.12rem rgba(217, 164, 65, 0.14);
	}

	.resource-chip[data-pressure='critical']::before {
		background: #dc625f;
		box-shadow: 0 0 0 0.12rem rgba(220, 98, 95, 0.16);
	}

	.resource-chip[data-pressure='warning'] strong {
		color: #f0c36a;
	}

	.resource-chip[data-pressure='critical'] strong {
		color: #f28a86;
	}

	.metric-value-hover {
		position: absolute;
		right: 0;
		top: calc(100% + 0.35rem);
		z-index: 45;
		display: block;
		width: max-content;
		max-width: min(16rem, calc(100vw - 2rem));
		padding: 0.34rem 0.48rem;
		border: 1px solid var(--app-border-strong);
		border-radius: 0.48rem;
		background: var(--app-bg);
		box-shadow: 0 14px 34px rgba(0, 0, 0, 0.68);
		color: var(--app-text);
		font-size: 0.72rem;
		line-height: 1.15;
		opacity: 0;
		pointer-events: none;
		transform: translateY(-2px);
		visibility: hidden;
		transition:
			opacity 120ms ease,
			transform 120ms ease,
			visibility 120ms ease;
	}

	.resource-chip:hover .metric-value-hover {
		opacity: 1;
		transform: translateY(0);
		visibility: visible;
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
			'containers'
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

	.container-card {
		grid-area: containers;
	}

	.log-card {
		grid-area: logs;
		max-height: 33vh;
		overflow: hidden;
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

	.config-item,
	.build-item,
	.service-log-item {
		display: flex;
		flex-direction: column;
		gap: 0.12rem;
	}

	.service-log-header {
		position: relative;
	}

	.config-button,
	.build-button {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.5rem 0.65rem;
		border: 0;
		border-radius: 0.65rem;
		background: var(--app-surface-raised);
		color: inherit;
		cursor: pointer;
		text-align: left;
	}

	.config-button:hover,
	.build-button:hover,
	.service-log-button:hover {
		background: var(--app-surface-hover);
	}

	.config-copy,
	.build-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.18rem;
	}

	.config-copy .row-title,
	.build-copy .row-title {
		align-items: center;
	}

	.config-output,
	.build-output {
		border-radius: 0.7rem;
		background: var(--app-bg);
		overflow: auto;
	}

	.build-output {
		max-height: 33vh;
		overflow-x: hidden;
		overflow-y: auto;
	}

	.service-log-button {
		width: 100%;
		text-align: left;
	}

	.service-log-button-linked {
		padding-right: 5.5rem;
	}

	.service-overview-link {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		right: 0.55rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.32rem;
		height: 2rem;
		min-width: 4.25rem;
		border: 1px solid var(--app-border);
		border-radius: 0.55rem;
		background: var(--app-control);
		color: var(--app-text-muted);
		font-size: 0.72rem;
		font-weight: 700;
		text-decoration: none;
	}

	.service-overview-link:hover,
	.service-overview-link:focus-visible {
		border-color: var(--app-border-strong);
		background: var(--app-control-hover);
		color: var(--app-text);
		outline: none;
	}

	.service-log-output {
		display: flex;
		flex-direction: column;
		max-height: 33vh;
		border-radius: 0.7rem;
		background: var(--app-bg);
		overflow: hidden;
	}

	.service-log-list {
		display: flex;
		min-height: 0;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 0.15rem;
		overflow-x: hidden;
		overflow-y: auto;
	}

	.service-log-row {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: 1rem;
		border-radius: 0.65rem;
		padding: 0.55rem 0.7rem;
		background: var(--app-surface-raised);
		font-size: 0.78rem;
	}

	.error-log-row {
		background: rgba(141, 61, 61, 0.16);
	}

	.command-log-row {
		background: rgba(29, 155, 240, 0.12);
		color: #d9f0ff;
	}

	.command-status {
		display: inline-grid;
		flex: none;
		width: 1rem;
		height: 1rem;
		place-items: center;
		border-radius: 999px;
		font-size: 0.68rem;
		font-weight: 800;
		line-height: 1;
	}

	.command-status-succeeded {
		background: rgba(78, 198, 112, 0.2);
		color: #77e39a;
	}

	.command-status-failed {
		background: rgba(226, 91, 91, 0.2);
		color: #ff9a96;
	}

	.command-form {
		display: grid;
		flex: none;
		grid-template-columns: minmax(0, 1fr) auto auto;
		gap: 0.45rem;
		padding: 0.55rem;
		background: var(--app-bg);
	}

	.command-form input {
		min-width: 0;
		border: 1px solid var(--app-border);
		border-radius: 0.5rem;
		background: var(--app-control);
		color: var(--app-text);
		padding: 0.46rem 0.58rem;
		font-size: 0.78rem;
		outline: none;
	}

	.command-form input:focus {
		border-color: var(--app-border-strong);
	}

	.command-form button,
	.process-kill-button {
		border: 1px solid var(--app-border);
		border-radius: 0.5rem;
		background: var(--app-control);
		color: var(--app-text-muted);
		padding: 0.42rem 0.56rem;
		font-size: 0.72rem;
		font-weight: 700;
		cursor: pointer;
	}

	.process-kill-button {
		opacity: 0;
		pointer-events: none;
		transform: translateY(-1px);
		transition:
			opacity 120ms ease,
			transform 120ms ease;
	}

	.process-item:hover .process-kill-button,
	.process-item:focus-within .process-kill-button,
	.process-kill-button:focus-visible {
		opacity: 1;
		pointer-events: auto;
		transform: translateY(0);
	}

	.command-form button:disabled {
		cursor: default;
		opacity: 0.5;
	}

	.command-form button:hover:enabled,
	.process-kill-button:hover {
		background: var(--app-control-hover);
		color: var(--app-text);
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

	.log-card .log-list {
		flex: 1 1 auto;
		overflow-x: hidden;
		overflow-y: auto;
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

	.output-error,
	.output-error .log-message {
		color: #e06c75;
	}

	.build-stream-row .log-message {
		white-space: pre-wrap;
	}

	.log-message {
		min-width: 0;
		overflow-wrap: anywhere;
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
		width: 100%;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		border-radius: 0.55rem;
		padding: 0;
		text-align: left;
	}

	.process-heading:hover {
		color: var(--app-text);
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

	.process-actions {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.35rem;
		min-width: 0;
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

	.danger-kill {
		color: #ffb6b3;
		border-color: rgba(141, 61, 61, 0.36);
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
