<script lang="ts">
	import { eq, inArray } from '@tanstack/db';
	import { useLiveQuery } from '@tanstack/svelte-db';
	import { onMount } from 'svelte';

	import Icon from '$lib/components/Icon.svelte';
	import {
		appendLog,
		checkHealth,
		type ComposeProject,
		type ComposeService,
		type LocalSettings,
		type LogEntry,
		type UiState,
		hydrateProjects,
		invalidateProjectServices,
		logsCollection,
		pauseServices,
		projectsCollection,
		refreshProjectsFromServer,
		reloadProjectServices,
		selectProject,
		settingsCollection,
		servicesCollection,
		setConnectionState,
		setProjectExpanded,
		setProjectWatch,
		startProject,
		startServices,
		startWatch,
		stopWatch,
		uiStateCollection,
		unpauseServices,
		updateUiState
	} from '$lib/central';

	type OpenProjectRow = {
		project: ComposeProject;
		services: {
			values: () => IterableIterator<ComposeService>;
		};
	};

	const uiQuery = useLiveQuery((q) => q.from({ ui: uiStateCollection }));
	const projectsQuery = useLiveQuery((q) => q.from({ projects: projectsCollection }));
	const settingsQuery = useLiveQuery((q) => q.from({ settings: settingsCollection }));
	const allLogsQuery = useLiveQuery((q) => q.from({ logs: logsCollection }));

	const uiState = $derived((uiQuery.data?.[0] as UiState | undefined) ?? undefined);
	const selectedProjectId = $derived(uiState?.selectedProjectId ?? '');
	const settings = $derived((settingsQuery.data?.[0] as LocalSettings | undefined) ?? undefined);
	const expandedProjectIdList = $derived((settings?.expandedProjectIds ?? []).slice().sort());
	const expandedProjectIds = $derived(new Set(expandedProjectIdList));

	const openProjectsQuery = useLiveQuery((q) => {
		const targetIds = expandedProjectIdList.length ? expandedProjectIdList : ['__none__'];

			return q
				.from({ projects: projectsCollection })
				.where(({ projects }) => inArray(projects.id, targetIds))
				.select(({ projects }) => ({
					project: projects,
					services: q
						.from({ services: servicesCollection })
						.where(({ services }) => eq(services.projectId, projects.id))
						.orderBy(({ services }) => services.serviceName)
						.orderBy(({ services }) => services.containerName)
				}));
		});

	const allLogs = $derived((allLogsQuery.data ?? []) as LogEntry[]);
	const openProjectRows = $derived((openProjectsQuery.data ?? []) as OpenProjectRow[]);

	function stateRank(state: ComposeProject['state']) {
		if (state === 'running') return 0;
		if (state === 'paused') return 1;
		if (state === 'exited') return 2;
		if (state === 'stopped') return 3;
		if (state === 'uncreated') return 4;
		return 5;
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

		return (
			stateRank(left.state) - stateRank(right.state) ||
			right.containerCount - left.containerCount ||
			left.name.localeCompare(right.name)
		);
	}

	const projects = $derived.by((): ComposeProject[] => {
		const entries = [...((projectsQuery.data ?? []) as ComposeProject[])];
		return entries.sort((left, right) => compareProjects(left, right, uiState?.sortBy ?? 'status'));
	});

	const servicesByProject = $derived.by(() => {
		const grouped = new Map<string, ComposeService[]>();

		for (const row of openProjectRows) {
			const services = [...row.services.values()];
			grouped.set(
				row.project.id,
				services.sort(
					(left, right) =>
						left.serviceName.localeCompare(right.serviceName) ||
						left.containerName.localeCompare(right.containerName)
				)
			);
		}

		return grouped;
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

	const selectedServices = $derived(
		selectedProject ? servicesByProject.get(selectedProject.id) ?? [] : []
	);
	const selectedLogs = $derived(
		selectedProject ? allLogs.filter((entry) => entry.projectId === selectedProject.id).slice().reverse() : []
	);
	const runningServices = $derived(
		selectedServices.length
			? selectedServices.filter((service) => service.state === 'running').length
			: selectedProject?.state === 'running'
				? selectedProject.containerCount
				: 0
	);
	const pausedServices = $derived(
		selectedServices.filter((service) => service.state === 'paused').length
	);
	const exitedServices = $derived(
		selectedServices.length
			? selectedServices.filter((service) => service.state === 'exited').length
			: selectedProject?.state === 'exited'
				? selectedProject.containerCount
				: 0
	);

	let refreshing = $state(false);
	let busyAction = $state<string | null>(null);

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

	onMount(() => {
		void refresh();
	});

	function projectServices(projectId: string) {
		return servicesByProject.get(projectId) ?? [];
	}

	function hasLoadedProjectServices(projectId: string) {
		return openProjectRows.some((row) => row.project.id === projectId);
	}

	function isProjectFullyPaused(project: ComposeProject) {
		const services = projectServices(project.id);

		if (services.length) {
			return services.every((service) => service.state === 'paused');
		}

		return project.state === 'paused' || project.statusLabel.toLowerCase().includes('paused');
	}

	function projectCanPause(project: ComposeProject) {
		const services = projectServices(project.id);

		if (services.length) {
			return services.some((service) => service.state === 'running' || service.state === 'paused');
		}

		return project.state === 'running' || project.state === 'paused';
	}

	function projectCanStart(project: ComposeProject) {
		const services = projectServices(project.id);

		if (services.length) {
			return services.some((service) =>
				['exited', 'created', 'unknown'].includes(service.state)
			);
		}

		return project.state !== 'running' && project.state !== 'paused';
	}

	function projectIconTone(project: ComposeProject) {
		const services = projectServices(project.id);

		if (services.length) {
			const running = services.filter((service) => service.state === 'running').length;
			const paused = services.filter((service) => service.state === 'paused').length;
			const exited = services.filter((service) => service.state === 'exited').length;

			if (running > 0 && paused === 0 && exited === 0) {
				return 'project-icon-running';
			}

			if (paused > 0 && running === 0 && exited === 0) {
				return 'project-icon-warning';
			}

			if (running > 0 || paused > 0) {
				return 'project-icon-warning';
			}

			if (exited > 0) {
				return 'project-icon-exited';
			}
		}

		if (project.state === 'running') {
			return 'project-icon-running';
		}

		if (project.state === 'uncreated') {
			return 'project-icon-uncreated';
		}

		if (project.state === 'paused' || project.statusLabel.toLowerCase().includes('paused')) {
			return 'project-icon-warning';
		}

		if (project.statusLabel.includes('running(') && project.statusLabel.includes('exited(')) {
			return 'project-icon-warning';
		}

		return 'project-icon-exited';
	}

	function serviceStateTone(service: ComposeService) {
		if (service.state === 'running') {
			return 'service-state-running';
		}

		if (service.state === 'paused') {
			return 'service-state-paused';
		}

		return 'service-state-exited';
	}

	function serviceStateIcon(service: ComposeService) {
		if (service.state === 'paused') {
			return 'pause';
		}

		if (service.state === 'running') {
			return 'play';
		}

		return 'container';
	}

	async function refresh() {
		if (!uiState) {
			return;
		}

		refreshing = true;
		setConnectionState('connecting', 'Connecting to Compose API at http://127.0.0.1:8094.');

		try {
			await checkHealth(uiState);
			const result = await refreshProjectsFromServer(uiState);
			hydrateProjects(result.projects, result.services);
			invalidateProjectServices();

			if (expandedProjectIdList.length) {
				await reloadProjectServices(expandedProjectIdList);
			}

			setConnectionState('connected', 'Compose API reachable and synchronized.');

			if (selectedProjectId) {
				appendLog(selectedProjectId, 'ok', 'Refreshed project list from the Compose API.');
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Server unavailable';
			setConnectionState('error', `Compose API unavailable at http://127.0.0.1:8094 (${message}).`);

			if (selectedProjectId) {
				appendLog(selectedProjectId, 'warn', 'Compose API unavailable.');
			}
		} finally {
			refreshing = false;
		}
	}

	async function syncAfterAction(project: ComposeProject, logMessage: string) {
		await refresh();

		if (expandedProjectIds.has(project.id)) {
			await reloadProjectServices([project.id]);
		}

		appendLog(project.id, 'ok', logMessage);
	}

	async function handleStart(project = selectedProject, service?: ComposeService) {
		if (!project || !uiState || busyAction) {
			return;
		}

		const serviceNames = service ? [service.serviceName] : undefined;
		busyAction = `start:${project.id}:${service?.id ?? 'project'}`;

		try {
			if (service) {
				await startServices(uiState, project, serviceNames);
				await syncAfterAction(project, `Started ${service.serviceName} in ${project.name}.`);
				setConnectionState('connected', `Started ${service.serviceName}.`);
			} else if (project.state === 'uncreated') {
				await startProject(uiState, project.path, project.watch);
				await syncAfterAction(project, `Started ${project.name} via /up.`);
				setConnectionState('connected', `Started ${project.name}.`);
			} else {
				await startServices(uiState, project);
				await syncAfterAction(project, `Started services for ${project.name}.`);
				setConnectionState('connected', `Started ${project.name}.`);
			}
		} catch {
			setConnectionState('error', `Failed to start ${service?.serviceName ?? project.name}.`);
			appendLog(project.id, 'warn', `Failed to start ${service?.serviceName ?? project.name}.`);
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
					`Resumed ${service?.serviceName ?? project.name}.`
				);
				setConnectionState('connected', `Resumed ${service?.serviceName ?? project.name}.`);
			} else {
				await pauseServices(uiState, project, serviceNames);
				await syncAfterAction(
					project,
					`Paused ${service?.serviceName ?? project.name}.`
				);
				setConnectionState('connected', `Paused ${service?.serviceName ?? project.name}.`);
			}
		} catch {
			setConnectionState(
				'error',
				`Failed to ${isUnpause ? 'resume' : 'pause'} ${service?.serviceName ?? project.name}.`
			);
			appendLog(
				project.id,
				'warn',
				`Failed to ${isUnpause ? 'resume' : 'pause'} ${service?.serviceName ?? project.name}.`
			);
		} finally {
			busyAction = null;
		}
	}

	async function handleWatchToggle(project = selectedProject) {
		if (!project || !uiState || busyAction) {
			return;
		}

		const nextWatch = !project.watch;
		busyAction = `watch:${project.id}`;

		try {
			if (nextWatch) {
				await startWatch(uiState, project.id, project.path);
				appendLog(project.id, 'ok', `Watch started for ${project.name}.`);
			} else {
				await stopWatch(uiState, project.id);
				appendLog(project.id, 'info', `Watch stopped for ${project.name}.`);
			}

			setProjectWatch(project.id, nextWatch);
			setConnectionState(
				'connected',
				`${nextWatch ? 'Watch attached to' : 'Watch removed from'} ${project.name}.`
			);
		} catch {
			setConnectionState(
				'error',
				`${nextWatch ? 'Failed to attach watch to' : 'Failed to remove watch from'} ${project.name}.`
			);
			appendLog(
				project.id,
				'warn',
				`${nextWatch ? 'Failed to attach watch' : 'Failed to remove watch'} for ${project.name}.`
			);
		} finally {
			busyAction = null;
		}
	}

	function handleProjectSelect(projectId: string) {
		selectProject(projectId);
	}

	function toggleProject(projectId: string) {
		setProjectExpanded(projectId, !expandedProjectIds.has(projectId));
	}
</script>

<svelte:head>
	<title>Compose Control</title>
	<meta
		name="description"
		content="Minimal Docker Compose control surface with a compact extension-style shell."
	/>
</svelte:head>

<div class="workspace">
	<aside class="sidebar">
		<div class="sidebar-controls">
			<label class="search">
				<Icon name="search" size={13} />
				<input
					type="text"
					value={uiState?.filter ?? ''}
					oninput={(event) =>
						updateUiState({ filter: (event.currentTarget as HTMLInputElement).value })}
					placeholder="Filter projects"
					aria-label="Filter projects"
				/>
			</label>

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
					<option value="status">Status</option>
					<option value="name">Project Name</option>
					<option value="path">Compose Path</option>
				</select>
			</label>

			<button
				class="refresh-button"
				type="button"
				aria-label="Refresh projects"
				onmousedown={refresh}
				disabled={refreshing || busyAction !== null}
			>
				<Icon name="refresh" size={13} spinning={refreshing} />
			</button>
		</div>

		<div class="tree" role="tree" aria-label="Compose projects">
			{#if visibleProjects.length}
				{#each visibleProjects as project (project.id)}
					<div class="project-group">
						<div
							class:selected={selectedProject?.id === project.id}
							class="project-row"
							role="treeitem"
							aria-selected={selectedProject?.id === project.id}
						>
							<button
								class="toggle"
								type="button"
								aria-label={expandedProjectIds.has(project.id) ? `Collapse ${project.name}` : `Expand ${project.name}`}
								aria-pressed={expandedProjectIds.has(project.id)}
								onmousedown={() => toggleProject(project.id)}
							>
								<Icon name="chevron" size={13} rotated={expandedProjectIds.has(project.id)} />
							</button>

							<button class="project-button" type="button" onmousedown={() => handleProjectSelect(project.id)}>
								<span class="project-copy">
									<span class="project-name">
										<Icon name="container" size={14} class={projectIconTone(project)} />
										{project.name}
									</span>
									<span class="project-status">{project.statusLabel}</span>
								</span>
								<span class="project-meta">{project.containerCount > 0 ? project.containerCount : ''}</span>
							</button>

							<div class="row-actions">
								{#if projectCanStart(project)}
									<button
										class="overlay-button"
										type="button"
										aria-label={`Start ${project.name}`}
										onmousedown={() => handleStart(project)}
										disabled={busyAction !== null}
									>
										<Icon name="play" size={13} />
									</button>
								{/if}

								{#if projectCanPause(project)}
									<button
										class="overlay-button"
										type="button"
										aria-label={`${isProjectFullyPaused(project) ? 'Unpause' : 'Pause'} ${project.name}`}
										onmousedown={() => handlePauseToggle(project)}
										disabled={busyAction !== null}
									>
										<Icon name={isProjectFullyPaused(project) ? 'play' : 'pause'} size={13} />
									</button>
								{/if}

								<button
									class="overlay-button"
									type="button"
									aria-label={`${project.watch ? 'Stop watch for' : 'Watch'} ${project.name}`}
									onmousedown={() => handleWatchToggle(project)}
									disabled={busyAction !== null}
								>
									<Icon name="watch" size={13} />
								</button>
							</div>
						</div>

						{#if expandedProjectIds.has(project.id)}
							<div class="service-list">
								{#if projectServices(project.id).length}
									{#each projectServices(project.id) as service (service.id)}
										<div class="service-row">
											<span class={`service-state ${serviceStateTone(service)}`}>
												<Icon name={serviceStateIcon(service)} size={13} />
											</span>
											<div class="service-copy">
												<div class="service-title">
													<span>{service.serviceName}</span>
													<span class="service-container">{service.containerName}</span>
												</div>
												<div class="service-subtitle">
													{service.stateText}
													{#if service.health}
														<span class="health-tag">({service.health})</span>
													{/if}
												</div>
											</div>

											<div class="row-actions">
												{#if ['exited', 'created', 'unknown'].includes(service.state)}
													<button
														class="overlay-button"
														type="button"
														aria-label={`Start ${service.serviceName}`}
														onmousedown={() => handleStart(project, service)}
														disabled={busyAction !== null}
													>
														<Icon name="play" size={13} />
													</button>
												{/if}

												{#if service.state === 'running' || service.state === 'paused'}
													<button
														class="overlay-button"
														type="button"
														aria-label={`${service.state === 'paused' ? 'Unpause' : 'Pause'} ${service.serviceName}`}
														onmousedown={() => handlePauseToggle(project, service)}
														disabled={busyAction !== null}
													>
														<Icon name={service.state === 'paused' ? 'play' : 'pause'} size={13} />
													</button>
												{/if}

												<button
													class="overlay-button"
													type="button"
													aria-label={`${project.watch ? 'Stop watch for' : 'Watch'} ${service.serviceName}`}
													onmousedown={() => handleWatchToggle(project)}
													disabled={busyAction !== null}
												>
													<Icon name="watch" size={13} />
												</button>
											</div>
										</div>
									{/each}
								{:else}
									<div class="service-empty">
										{hasLoadedProjectServices(project.id)
											? 'No containers returned by /ps.'
											: 'Loading containers…'}
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			{:else}
				<div class="sidebar-empty">No Compose projects available.</div>
			{/if}
		</div>
	</aside>

	<main class="panel">
		<header class="panel-header">
			<div class="panel-heading">
				<div class="status-line">
					<span
						class:connected={uiState?.status === 'connected'}
						class:error-state={uiState?.status === 'error'}
						class="status-dot"
					></span>
					<span class="status-copy">{uiState?.statusDetail}</span>
				</div>
				<h2>{selectedProject?.name ?? 'Compose Projects'}</h2>
			</div>
		</header>

		<div class="content-grid">
			<section class="card summary-card">
				<div class="card-header">
					<div>
						<p class="eyebrow">Project</p>
						<h3>{selectedProject?.path ?? 'http://127.0.0.1:8094'}</h3>
					</div>
					<div class="pill-row">
						<span
							class:active-pill={selectedProject?.state === 'running' || (selectedProject ? isProjectFullyPaused(selectedProject) : false)}
							class="pill"
						>
							{selectedProject?.statusLabel ?? 'Unknown'}
						</span>
						<span class:active-pill={selectedProject?.watch} class="pill">
							{selectedProject?.watch ? 'Watch Active' : 'No Watch'}
						</span>
					</div>
				</div>

				<div class="metrics">
					<div class="metric">
						<span class="metric-label">Running</span>
						<strong>{runningServices}</strong>
					</div>
					<div class="metric">
						<span class="metric-label">Paused</span>
						<strong>{pausedServices}</strong>
					</div>
					<div class="metric">
						<span class="metric-label">Exited</span>
						<strong>{exitedServices}</strong>
					</div>
					<div class="metric">
						<span class="metric-label">Watch</span>
						<strong>{selectedProject?.watch ? 'On' : 'Off'}</strong>
					</div>
				</div>

				{#if selectedServices.length}
					<div class="compact-list">
						{#each selectedServices as service (service.id)}
							<div class="compact-row">
								<div>
									<div class="row-title">{service.serviceName}</div>
									<div class="row-subtitle">{service.containerName}</div>
								</div>
								<div class="row-tail">
									<span
										class:ok-state={service.state === 'running'}
										class:warn-state={service.state === 'paused'}
										class="state-chip"
									>
										{service.state}
									</span>
									<span>{service.stateText}</span>
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

			<section class="card log-card">
				<div class="card-header">
					<div>
						<p class="eyebrow">Watch Output</p>
						<h3>{selectedProject?.name ?? 'No project selected'}</h3>
					</div>
					<div class="log-hint">Live watch stream</div>
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
					<div class="empty-state">No watch output yet.</div>
				{/if}
			</section>
		</div>
	</main>
</div>

<style>
	:global(body) {
		min-width: 320px;
	}

	.workspace {
		display: grid;
		height: 100vh;
		min-height: 0;
		grid-template-columns: minmax(18rem, 24rem) minmax(0, 1fr);
		background: #070708;
		overflow: hidden;
	}

	.sidebar {
		display: flex;
		min-height: 0;
		flex-direction: column;
		border-right: 1px solid rgba(255, 255, 255, 0.08);
		background:
			linear-gradient(180deg, rgba(14, 14, 15, 0.99), rgba(8, 8, 9, 0.99)),
			#080809;
		overflow: hidden;
	}

	.panel-header,
	.card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	h2,
	h3,
	p {
		margin: 0;
	}

	h2 {
		font-size: 1.05rem;
		font-weight: 600;
	}

	h3 {
		font-size: 0.94rem;
		font-weight: 600;
	}

	.eyebrow {
		margin-bottom: 0.15rem;
		font-size: 0.68rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #8c9197;
	}

	.pill-row {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	.refresh-button,
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
		color: #9a9ea3;
	}

	.refresh-button:hover:enabled {
		background: rgba(255, 255, 255, 0.06);
		color: #ebedf0;
	}

	.refresh-button:disabled {
		cursor: default;
		opacity: 0.55;
	}

	.sidebar-controls {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
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
		color: #92979d;
	}

	.toggle:hover {
		background: rgba(255, 255, 255, 0.06);
		color: #e7eaed;
	}

	.search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 1.95rem;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 0.6rem;
		background: rgba(255, 255, 255, 0.03);
		padding: 0 0.58rem;
		color: #93989e;
	}

	.search input {
		width: 100%;
		height: 100%;
		min-height: 0;
		border: 0;
		background: transparent;
		color: #e4e7ea;
		padding: 0;
		line-height: 1;
		outline: none;
		font-size: 0.82rem;
	}

	.sort-menu {
		display: inline-flex;
		align-items: center;
		gap: 0.42rem;
		color: #93989e;
	}

	.sort-menu select {
		min-width: 7.25rem;
		height: 1.95rem;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 0.6rem;
		background: rgba(255, 255, 255, 0.03);
		padding: 0 1.85rem 0 0.72rem;
		font-size: 0.77rem;
		font-weight: 600;
		line-height: 1;
		color: #e4e7ea;
		outline: none;
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

	.project-row.selected {
		background: rgba(255, 255, 255, 0.05);
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
		flex-direction: column;
		align-items: flex-start;
		gap: 0.08rem;
	}

	.project-name {
		display: inline-flex;
		min-width: 0;
		align-items: center;
		gap: 0.48rem;
		font-size: 0.82rem;
		font-weight: 600;
		color: #eef0f2;
	}

	.project-status {
		font-size: 0.72rem;
		color: #989ea6;
	}

	:global(.project-icon-uncreated) {
		color: #6f747a;
	}

	:global(.project-icon-running) {
		color: #70bc7b;
	}

	:global(.project-icon-warning) {
		color: #c7a45f;
	}

	:global(.project-icon-exited) {
		color: #c76a68;
	}

	.project-meta {
		flex: none;
		margin-left: auto;
		min-width: 1.25rem;
		text-align: right;
		font-size: 0.72rem;
		font-weight: 700;
		color: #848b94;
		transform: translateX(-6px);
	}

	.service-list {
		margin-left: 1.9rem;
		border-left: 1px solid rgba(255, 255, 255, 0.08);
		padding: 0.08rem 0 0.28rem 0.68rem;
	}

	.service-row {
		position: relative;
		display: flex;
		gap: 0.58rem;
		padding: 0.24rem 0;
		overflow: visible;
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

	.service-copy {
		min-width: 0;
		font-size: 0.8rem;
	}

	.service-title,
	.row-title {
		display: flex;
		gap: 0.35rem;
		font-weight: 600;
		color: #eef0f2;
	}

	.service-container,
	.row-subtitle {
		color: #a4aab2;
		font-weight: 500;
	}

	.service-subtitle {
		color: #969ca5;
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

	.project-row:hover .row-actions,
	.service-row:hover .row-actions {
		opacity: 1;
		pointer-events: auto;
	}

	.overlay-button {
		display: grid;
		height: 1.7rem;
		width: 1.7rem;
		place-items: center;
		border-radius: 0.5rem;
		border: 1px solid rgba(255, 255, 255, 0.11);
		background: rgba(10, 10, 11, 0.98);
		color: #d5d9de;
		box-shadow: 0 10px 22px rgba(0, 0, 0, 0.32);
	}

	.overlay-button:hover:enabled {
		border-color: rgba(255, 255, 255, 0.16);
		background: rgba(25, 25, 27, 0.99);
		color: #f2f4f7;
	}

	.overlay-button:disabled {
		cursor: default;
		opacity: 0.55;
	}

	.sidebar-empty,
	.service-empty,
	.empty-state {
		display: grid;
		place-items: center;
		border-radius: 0.8rem;
		background: rgba(255, 255, 255, 0.015);
		font-size: 0.8rem;
		color: #9aa1aa;
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
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
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
		font-size: 0.8rem;
		color: #9aa1aa;
	}

	.status-dot {
		height: 0.5rem;
		width: 0.5rem;
		border-radius: 999px;
		background: #d1a15f;
		box-shadow: 0 0 0 0.16rem rgba(209, 161, 95, 0.15);
	}

	.status-dot.connected {
		background: #69d08b;
		box-shadow: 0 0 0 0.16rem rgba(105, 208, 139, 0.15);
	}

	.status-dot.error-state {
		background: #d08266;
		box-shadow: 0 0 0 0.16rem rgba(208, 130, 102, 0.15);
	}

	.content-grid {
		display: grid;
		flex: 1;
		min-height: 0;
		grid-template-columns: 1fr;
		grid-template-areas:
			'summary'
			'logs';
		gap: 0.9rem;
		padding-top: 0.95rem;
	}

	.card {
		display: flex;
		min-height: 0;
		flex-direction: column;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 0.95rem;
		background:
			linear-gradient(180deg, rgba(17, 17, 18, 0.97), rgba(11, 11, 12, 0.99)),
			#0b0b0c;
		padding: 0.95rem 1rem;
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
	}

	.summary-card {
		grid-area: summary;
	}

	.log-card {
		grid-area: logs;
	}

	.pill {
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.06);
		padding: 0.28rem 0.56rem;
		font-size: 0.73rem;
		font-weight: 700;
		color: #9fa6af;
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

	.metrics {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.7rem;
		margin: 0.95rem 0 1rem;
	}

	.metric {
		border-radius: 0.8rem;
		background: rgba(255, 255, 255, 0.02);
		padding: 0.75rem;
	}

	.metric-label,
	.log-hint {
		font-size: 0.75rem;
		color: #9aa1aa;
	}

	.metric strong {
		display: block;
		margin-top: 0.2rem;
		font-size: 1.1rem;
		font-weight: 700;
		color: #edf0f3;
	}

	.compact-list,
	.log-list {
		display: flex;
		min-height: 0;
		flex-direction: column;
		gap: 0.15rem;
		overflow: auto;
	}

	.compact-row,
	.log-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		border-radius: 0.65rem;
		padding: 0.55rem 0.65rem;
		background: rgba(255, 255, 255, 0.015);
	}

	.row-tail {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		font-size: 0.77rem;
		color: #a3aab3;
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
		background: rgba(255, 255, 255, 0.08);
		color: #ccd2d8;
	}

	.log-warn {
		background: rgba(160, 115, 65, 0.18);
		color: #f0cf9f;
	}

	.log-time {
		width: 3rem;
		color: #848c95;
		font-variant-numeric: tabular-nums;
	}

	.log-message {
		color: #dce0e5;
	}

	.empty-state {
		min-height: 9rem;
	}

	@media (max-width: 1100px) {
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
	}

	@media (max-width: 640px) {
		.sidebar-controls {
			grid-template-columns: minmax(0, 1fr) auto auto;
			gap: 0.42rem;
		}

		.sort-menu select {
			min-width: 0;
			width: 5.9rem;
		}
	}
</style>
