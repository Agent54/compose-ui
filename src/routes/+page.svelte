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
	const allServicesQuery = useLiveQuery((q) => q.from({ services: servicesCollection }));
	const allLogsQuery = useLiveQuery((q) => q.from({ logs: logsCollection }));

	const selectedProjectId = $derived(uiQuery.data?.[0]?.selectedProjectId ?? '');
	const uiState = $derived((uiQuery.data?.[0] as UiState | undefined) ?? undefined);
	const projects = $derived.by((): ComposeProject[] => {
		const entries = [...((projectsQuery.data ?? []) as ComposeProject[])];
		return entries.sort((left, right) => left.name.localeCompare(right.name));
	});
	const allServices = $derived((allServicesQuery.data ?? []) as ComposeService[]);
	const allLogs = $derived((allLogsQuery.data ?? []) as LogEntry[]);
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
		selectedServices.filter((service) => service.state === 'running').length
	);
	const exitedServices = $derived(selectedServices.filter((service) => service.state === 'exited').length);

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

	async function handleUp() {
		if (!selectedProject || !uiState || busyAction) {
			return;
		}

		busyAction = 'up';

		try {
			await startProject(uiState, selectedProject.path, selectedProject.watch);
			setProjectState(selectedProject.id, 'running');
			setConnectionState('connected', `Started ${selectedProject.name}.`);
			appendLog(selectedProject.id, 'ok', `Started ${selectedProject.name} via /up.`);
		} catch {
			setConnectionState('error', `Failed to start ${selectedProject.name} from http://127.0.0.1:8094.`);
			appendLog(selectedProject.id, 'warn', `Failed to start ${selectedProject.name}.`);
		} finally {
			busyAction = null;
		}
	}

	async function handleWatchToggle() {
		if (!selectedProject || !uiState || busyAction) {
			return;
		}

		const nextWatch = !selectedProject.watch;
		busyAction = 'watch';

		try {
			if (nextWatch) {
				await startWatch(uiState, selectedProject.id, selectedProject.path);
				appendLog(selectedProject.id, 'ok', `Watch started for ${selectedProject.name}.`);
			} else {
				await stopWatch(uiState, selectedProject.id);
				appendLog(selectedProject.id, 'info', `Watch stopped for ${selectedProject.name}.`);
			}

			setProjectWatch(selectedProject.id, nextWatch);
			setConnectionState(
				'connected',
				`${nextWatch ? 'Watch attached to' : 'Watch removed from'} ${selectedProject.name}.`
			);
		} catch {
			setConnectionState(
				'error',
				`${nextWatch ? 'Failed to attach watch to' : 'Failed to remove watch from'} ${selectedProject.name}.`
			);
			appendLog(
				selectedProject.id,
				'warn',
				`${nextWatch ? 'Failed to attach watch' : 'Failed to remove watch'} for ${selectedProject.name}.`
			);
		} finally {
			busyAction = null;
		}
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
		<header class="sidebar-header">
			<div>
				<p class="eyebrow">Docker Compose</p>
				<h1>Containers</h1>
			</div>
		</header>

		<div class="sidebar-actions">
			<button
				class="sidebar-action"
				type="button"
				aria-label="Refresh"
				onmousedown={refresh}
				disabled={refreshing}
			>
				<Icon name="refresh" size={13} spinning={refreshing} />
				<span>{refreshing ? 'Syncing…' : 'Refresh'}</span>
			</button>
			<button
				class="sidebar-action"
				type="button"
				aria-label="Up selected project"
				onmousedown={handleUp}
				disabled={!selectedProject || busyAction !== null}
			>
				<Icon name="play" size={13} />
				<span>{busyAction === 'up' ? 'Starting…' : 'Up'}</span>
			</button>
			<button
				class="sidebar-action"
				type="button"
				aria-label="Toggle watch for selected project"
				onmousedown={handleWatchToggle}
				disabled={!selectedProject || busyAction !== null}
			>
				<Icon name="watch" size={13} />
				<span>{busyAction === 'watch' ? 'Working…' : selectedProject?.watch ? 'Stop Watch' : 'Watch'}</span>
			</button>
		</div>

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
								aria-label={project.expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
								aria-pressed={project.expanded}
								onmousedown={() => setProjectExpanded(project.id, !project.expanded)}
							>
								<Icon name="chevron" rotated={project.expanded} />
							</button>

							<button class="project-button" type="button" onmousedown={() => selectProject(project.id)}>
								<span class="project-name">
									<Icon name="container" size={13} />
									{project.name}
								</span>
								<span class="project-meta">{project.updatedLabel}</span>
							</button>
						</div>

						{#if project.expanded && (servicesByProject.get(project.id)?.length ?? 0) > 0}
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
							{selectedProject?.state === 'running' ? 'Running' : 'Stopped'}
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
		min-height: 100vh;
		grid-template-columns: minmax(18rem, 24rem) minmax(0, 1fr);
		background: #090c11;
	}

	.sidebar {
		display: flex;
		flex-direction: column;
		border-right: 1px solid rgba(129, 146, 170, 0.16);
		background:
			linear-gradient(180deg, rgba(18, 24, 34, 0.98), rgba(13, 17, 24, 0.96)),
			#0a0d12;
	}

	.sidebar-header,
	.panel-header,
	.card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.sidebar-header {
		padding: 0.95rem 1rem 0.5rem;
	}

	h1,
	h2,
	h3,
	p {
		margin: 0;
	}

	h1 {
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
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

	.sidebar-actions,
	.pill-row {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	.sidebar-actions {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		padding: 0 0.75rem 0.6rem;
	}

	.sidebar-action,
	.toggle,
	.project-button {
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	.sidebar-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		border-radius: 0.6rem;
		border: 1px solid rgba(126, 143, 166, 0.18);
		background: rgba(18, 24, 33, 0.72);
		padding: 0.42rem 0.48rem;
		font-size: 0.72rem;
		font-weight: 600;
		color: #d9e3ef;
		white-space: nowrap;
	}

	.sidebar-action:hover:enabled {
		border-color: rgba(154, 173, 198, 0.26);
		background: rgba(25, 34, 46, 0.9);
	}

	.sidebar-action:disabled {
		cursor: default;
		opacity: 0.55;
	}

	.toggle {
		display: grid;
		height: 1.7rem;
		width: 1.7rem;
		place-items: center;
		border-radius: 0.45rem;
		color: #95a3b6;
	}

	.toggle:hover {
		background: rgba(106, 124, 151, 0.12);
		color: #dbe3ee;
	}

	.search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0.75rem 0.55rem;
		border: 1px solid rgba(120, 138, 162, 0.18);
		border-radius: 0.6rem;
		background: rgba(10, 14, 19, 0.82);
		padding: 0 0.7rem;
		color: #8091a6;
	}

	.search input {
		width: 100%;
		border: 0;
		background: transparent;
		color: #dfe7f2;
		padding: 0.58rem 0;
		outline: none;
		font-size: 0.82rem;
	}

	.tree {
		flex: 1;
		overflow: auto;
		padding: 0 0.2rem 0.85rem;
	}

	.project-group + .project-group {
		margin-top: 0.1rem;
	}

	.project-row {
		display: grid;
		grid-template-columns: 1.8rem minmax(0, 1fr);
		align-items: center;
		padding-right: 0.4rem;
		border-radius: 0.5rem;
	}

	.project-row.selected {
		background: rgba(18, 59, 111, 0.55);
	}

	.project-button {
		display: flex;
		min-width: 0;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.34rem 0.35rem 0.34rem 0;
		text-align: left;
	}

	.project-name {
		display: inline-flex;
		min-width: 0;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.82rem;
		font-weight: 600;
	}

	.project-meta {
		flex: none;
		font-size: 0.72rem;
		color: #7f8da0;
	}

	.service-list {
		margin-left: 1.9rem;
		border-left: 1px solid rgba(107, 121, 141, 0.16);
		padding: 0.08rem 0 0.28rem 0.65rem;
	}

	.service-row {
		display: flex;
		gap: 0.55rem;
		padding: 0.19rem 0;
	}

	.service-state {
		display: inline-flex;
		padding-top: 0.18rem;
		color: #c76363;
	}

	.service-state-running {
		color: #5ccc75;
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
		flex-direction: column;
		padding: 1rem 1rem 1.15rem;
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
		grid-template-columns: 1fr;
		grid-template-areas:
			'summary'
			'logs';
		gap: 0.9rem;
		min-height: 0;
		padding-top: 0.95rem;
	}

	.card {
		display: flex;
		min-height: 0;
		flex-direction: column;
		border: 1px solid rgba(120, 138, 162, 0.16);
		border-radius: 0.95rem;
		background:
			linear-gradient(180deg, rgba(17, 22, 31, 0.96), rgba(12, 16, 22, 0.98)),
			#0d1218;
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
			min-height: 100vh;
			border-right: 0;
		}
	}

	@media (max-width: 520px) {
		.sidebar-action {
			padding-inline: 0.42rem;
		}

		.sidebar-action span {
			display: none;
		}
	}

	@media (max-width: 260px) {
		.sidebar-actions {
			grid-template-columns: 1fr;
		}
	}
</style>
