<script lang="ts">
	import { useLiveQuery } from '@tanstack/svelte-db';
	import { onMount } from 'svelte';

	import Icon from '$lib/components/Icon.svelte';
	import {
		appendLog,
		checkHealth,
		type ComposeProject,
		type ComposeService,
		type LogEntry,
		type UiState,
		hydrateProjects,
		logsCollection,
		projectsCollection,
		refreshProjectsFromServer,
		selectProject,
		settingsCollection,
		servicesCollection,
		setConnectionState,
		setProjectExpanded,
		setProjectState,
		setProjectWatch,
		startProject,
		startWatch,
		stopWatch,
		uiStateCollection,
		updateUiState
	} from '$lib/central';

	const uiQuery = useLiveQuery((q) => q.from({ ui: uiStateCollection }));
	const projectsQuery = useLiveQuery((q) => q.from({ projects: projectsCollection }));
	const settingsQuery = useLiveQuery((q) => q.from({ settings: settingsCollection }));
	const allServicesQuery = useLiveQuery((q) => q.from({ services: servicesCollection }));
	const allLogsQuery = useLiveQuery((q) => q.from({ logs: logsCollection }));

	const selectedProjectId = $derived(uiQuery.data?.[0]?.selectedProjectId ?? '');
	const uiState = $derived((uiQuery.data?.[0] as UiState | undefined) ?? undefined);
	const settings = $derived(
		(settingsQuery.data?.[0] as unknown as { id: 'localstorage'; expandedProjectIds: string[] } | undefined) ??
			undefined
	);
	const expandedProjectIds = $derived(new Set(settings?.expandedProjectIds ?? []));
	const allServices = $derived((allServicesQuery.data ?? []) as ComposeService[]);
	const allLogs = $derived((allLogsQuery.data ?? []) as LogEntry[]);

	function stateRank(state: ComposeProject['state']) {
		if (state === 'running') return 0;
		if (state === 'exited') return 1;
		if (state === 'stopped') return 2;
		if (state === 'uncreated') return 3;
		return 4;
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

		for (const service of allServices) {
			const current = grouped.get(service.projectId);

			if (current) {
				current.push(service);
			} else {
				grouped.set(service.projectId, [service]);
			}
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
		() => projects.find((project) => project.id === selectedProjectId) ?? visibleProjects[0]
	);

	const selectedServices = $derived(selectedProject ? servicesByProject.get(selectedProject.id) ?? [] : []);
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
	const exitedServices = $derived(
		selectedServices.length
			? selectedServices.filter((service) => service.state === 'exited').length
			: selectedProject?.state === 'exited'
				? selectedProject.containerCount
				: 0
	);

	let refreshing = $state(false);
	let busyAction = $state<'up' | 'watch' | null>(null);

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

	async function handleUp(project = selectedProject) {
		if (!project || !uiState || busyAction) {
			return;
		}

		busyAction = 'up';

		try {
			await startProject(uiState, project.path, project.watch);
			setProjectState(project.id, 'running');
			setConnectionState('connected', `Started ${project.name}.`);
			appendLog(project.id, 'ok', `Started ${project.name} via /up.`);
		} catch {
			setConnectionState('error', `Failed to start ${project.name} from http://127.0.0.1:8094.`);
			appendLog(project.id, 'warn', `Failed to start ${project.name}.`);
		} finally {
			busyAction = null;
		}
	}

	async function handleWatchToggle(project = selectedProject) {
		if (!project || !uiState || busyAction) {
			return;
		}

		const nextWatch = !project.watch;
		busyAction = 'watch';

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

	function projectIconTone(project: ComposeProject) {
		if (project.state === 'running') {
			return 'project-icon-running';
		}

		if (project.state === 'uncreated') {
			return 'project-icon-uncreated';
		}

		if (project.statusLabel.includes('running(') && project.statusLabel.includes('exited(')) {
			return 'project-icon-warning';
		}

		return 'project-icon-exited';
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
				<Icon name="sort" size={12} />
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
				<Icon name="refresh" size={12} spinning={refreshing} />
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
								onmousedown={() => setProjectExpanded(project.id, !expandedProjectIds.has(project.id))}
							>
								<Icon name="chevron" rotated={expandedProjectIds.has(project.id)} />
							</button>

							<button class="project-button" type="button" onmousedown={() => handleProjectSelect(project.id)}>
								<span class="project-copy">
									<span class="project-name">
										<Icon name="container" size={13} class={projectIconTone(project)} />
										{project.name}
									</span>
									<span class="project-status">{project.statusLabel}</span>
								</span>
								<span class="project-meta">{project.containerCount > 0 ? project.containerCount : ''}</span>
							</button>

							<div class="row-actions">
								<button
									class="overlay-button"
									type="button"
									aria-label={`Up ${project.name}`}
									onmousedown={() => handleUp(project)}
									disabled={busyAction !== null}
								>
									<Icon name="play" size={11} />
								</button>
								<button
									class="overlay-button"
									type="button"
									aria-label={`${project.watch ? 'Stop watch for' : 'Watch'} ${project.name}`}
									onmousedown={() => handleWatchToggle(project)}
									disabled={busyAction !== null}
								>
									<Icon name="watch" size={11} />
								</button>
							</div>
						</div>

						{#if expandedProjectIds.has(project.id) && (servicesByProject.get(project.id)?.length ?? 0) > 0}
							<div class="service-list">
								{#each servicesByProject.get(project.id) ?? [] as service (service.id)}
									<div class="service-row">
										<span class:service-state-running={service.state === 'running'} class="service-state">
											<Icon name="play" size={11} />
										</span>
										<div class="service-copy">
											<div class="service-title">
												<span>{service.name}</span>
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
											<button
												class="overlay-button"
												type="button"
												aria-label={`Up ${project.name}`}
												onmousedown={() => handleUp(project)}
												disabled={busyAction !== null}
											>
												<Icon name="play" size={11} />
											</button>
											<button
												class="overlay-button"
												type="button"
												aria-label={`${project.watch ? 'Stop watch for' : 'Watch'} ${project.name}`}
												onmousedown={() => handleWatchToggle(project)}
												disabled={busyAction !== null}
											>
												<Icon name="watch" size={11} />
											</button>
										</div>
									</div>
								{/each}
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
						<span class:active-pill={selectedProject?.state === 'running'} class="pill">
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
						<span class="metric-label">Exited</span>
						<strong>{exitedServices}</strong>
					</div>
					<div class="metric">
						<span class="metric-label">Watch</span>
						<strong>{selectedProject?.watch ? 'On' : 'Off'}</strong>
					</div>
					<div class="metric">
						<span class="metric-label">Source</span>
						<strong>8094</strong>
					</div>
				</div>

				{#if selectedServices.length}
					<div class="compact-list">
						{#each selectedServices as service (service.id)}
							<div class="compact-row">
								<div>
									<div class="row-title">{service.name}</div>
									<div class="row-subtitle">{service.containerName}</div>
								</div>
								<div class="row-tail">
									<span class:ok-state={service.state === 'running'} class="state-chip">
										{service.state === 'running' ? 'Up' : 'Exited'}
									</span>
									<span>{service.stateText}</span>
								</div>
							</div>
						{/each}
					</div>
				{:else}
					<div class="empty-state">No service detail exposed by the API.</div>
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
		background: #090a0b;
		overflow: hidden;
	}

	.sidebar {
		display: flex;
		min-height: 0;
		flex-direction: column;
		border-right: 1px solid rgba(129, 146, 170, 0.16);
		background:
			linear-gradient(180deg, rgba(17, 17, 18, 0.98), rgba(11, 11, 12, 0.98)),
			#0a0a0b;
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
		color: #8a97a8;
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
		height: 1.55rem;
		width: 1.55rem;
		place-items: center;
		border-radius: 0.45rem;
		color: #979b9f;
	}

	.refresh-button:hover:enabled {
		background: rgba(255, 255, 255, 0.06);
		color: #e5e7ea;
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
		height: 1.7rem;
		width: 1.7rem;
		place-items: center;
		border-radius: 0.45rem;
		color: #90959b;
	}

	.toggle:hover {
		background: rgba(255, 255, 255, 0.06);
		color: #e2e5e9;
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
		color: #8f949b;
	}

	.search input {
		width: 100%;
		height: 100%;
		min-height: 0;
		border: 0;
		background: transparent;
		color: #dfe7f2;
		padding: 0;
		line-height: 1;
		outline: none;
		font-size: 0.82rem;
	}

	.sort-menu {
		display: inline-flex;
		align-items: center;
		gap: 0.42rem;
		color: #8f949b;
	}

	.sort-menu select {
		min-width: 7.2rem;
		height: 1.95rem;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 0.6rem;
		background: rgba(255, 255, 255, 0.03);
		padding: 0 1.85rem 0 0.72rem;
		font-size: 0.77rem;
		font-weight: 600;
		line-height: 1;
		color: #dfe7f2;
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
		padding: 0.34rem 0.55rem 0.34rem 0;
		text-align: left;
	}

	.project-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.06rem;
	}

	.project-name {
		display: inline-flex;
		min-width: 0;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.82rem;
		font-weight: 600;
	}

	.project-status {
		font-size: 0.72rem;
		color: #8fa0b5;
	}

	:global(.project-icon-uncreated) {
		color: #6d7278;
	}

	:global(.project-icon-running) {
		color: #6fb67b;
	}

	:global(.project-icon-warning) {
		color: #bda36a;
	}

	:global(.project-icon-exited) {
		color: #b76f6f;
	}

	.project-meta {
		flex: none;
		margin-left: auto;
		min-width: 1.25rem;
		text-align: right;
		font-size: 0.72rem;
		font-weight: 700;
		color: #7f8da0;
		transform: translateX(-6px);
	}

	.service-list {
		margin-left: 1.9rem;
		border-left: 1px solid rgba(107, 121, 141, 0.16);
		border-left-color: rgba(255, 255, 255, 0.08);
		padding: 0.08rem 0 0.28rem 0.65rem;
	}

	.service-row {
		position: relative;
		display: flex;
		gap: 0.55rem;
		padding: 0.19rem 0;
		overflow: visible;
	}

	.service-state {
		display: inline-flex;
		padding-top: 0.18rem;
		color: #c76363;
	}

	.service-state-running {
		color: #78c788;
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
		color: #edf3fb;
	}

	.service-container,
	.row-subtitle {
		color: #a5b2c3;
		font-weight: 500;
	}

	.service-subtitle {
		color: #95a2b4;
	}

	.health-tag {
		color: #7fe39a;
	}

	.row-actions {
		position: absolute;
		top: 50%;
		right: 0.3rem;
		display: inline-flex;
		gap: 0.22rem;
		transform: translateY(-50%);
		opacity: 0;
		pointer-events: none;
		transition: opacity 120ms ease;
		z-index: 3;
	}

	.project-row:hover .row-actions,
	.project-row:focus-within .row-actions,
	.service-row:hover .row-actions,
	.service-row:focus-within .row-actions {
		opacity: 1;
		pointer-events: auto;
	}

	.overlay-button {
		display: grid;
		height: 1.45rem;
		width: 1.45rem;
		place-items: center;
		border-radius: 0.45rem;
		border: 1px solid rgba(126, 143, 166, 0.16);
		background: rgba(9, 9, 10, 0.96);
		color: #c8d3e1;
		box-shadow: 0 8px 18px rgba(0, 0, 0, 0.28);
	}

	.overlay-button:hover:enabled {
		border-color: rgba(255, 255, 255, 0.12);
		background: rgba(24, 24, 26, 0.98);
	}

	.overlay-button:disabled {
		cursor: default;
		opacity: 0.55;
	}

	.sidebar-empty,
	.empty-state {
		display: grid;
		place-items: center;
		border-radius: 0.8rem;
		background: rgba(255, 255, 255, 0.015);
		font-size: 0.8rem;
		color: #98a7bb;
	}

	.sidebar-empty {
		margin: 0 0.55rem;
		min-height: 8rem;
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
		border-bottom: 1px solid rgba(123, 141, 164, 0.14);
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
		color: #96a4b6;
	}

	.status-dot {
		height: 0.5rem;
		width: 0.5rem;
		border-radius: 999px;
		background: #d7a45b;
		box-shadow: 0 0 0 0.16rem rgba(215, 164, 91, 0.15);
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
		border: 1px solid rgba(120, 138, 162, 0.16);
		border-radius: 0.95rem;
		background:
			linear-gradient(180deg, rgba(18, 18, 19, 0.96), rgba(12, 12, 13, 0.98)),
			#0d0d0e;
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
		background: rgba(86, 101, 120, 0.16);
		padding: 0.28rem 0.56rem;
		font-size: 0.73rem;
		font-weight: 700;
		color: #91a3b8;
	}

	.active-pill,
	.ok-state {
		color: #c8f4d2;
		background: rgba(61, 136, 88, 0.18);
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
		color: #94a3b8;
	}

	.metric strong {
		display: block;
		margin-top: 0.2rem;
		font-size: 1.1rem;
		font-weight: 700;
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
		color: #9aacbf;
	}

	.state-chip {
		border-radius: 999px;
		padding: 0.18rem 0.48rem;
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		background: rgba(123, 84, 84, 0.2);
		color: #ffb6b6;
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
		background: rgba(71, 101, 148, 0.18);
		color: #b7ceee;
	}

	.log-warn {
		background: rgba(160, 115, 65, 0.18);
		color: #f0cf9f;
	}

	.log-time {
		width: 3rem;
		color: #8293a7;
		font-variant-numeric: tabular-nums;
	}

	.log-message {
		color: #d7dfeb;
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
			grid-template-columns: minmax(0, 1fr) auto;
		}

		.sort-menu {
			justify-content: flex-end;
		}
	}
</style>
