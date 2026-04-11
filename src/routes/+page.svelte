<script lang="ts">
	import { useLiveQuery } from '@tanstack/svelte-db';
	import { onMount } from 'svelte';

	import Icon from '$lib/components/Icon.svelte';
	import {
		apiRoutes,
		apiSchema,
		appendLog,
		type ComposeProject,
		type ComposeService,
		type LogEntry,
		type UiState,
		hydrateProjects,
		logsCollection,
		pingServer,
		projectsCollection,
		refreshProjectsFromServer,
		routeGroups,
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
				continue;
			}

			grouped.set(service.projectId, [service]);
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

	const selectedServices = $derived(servicesByProject.get(selectedProjectId) ?? []);
	const selectedLogs = $derived(
		allLogs.filter((entry) => entry.projectId === selectedProjectId).slice().reverse()
	);
	const runningServices = $derived(
		selectedServices.filter((service) => service.state === 'running').length
	);
	const exitedServices = $derived(selectedServices.filter((service) => service.state === 'exited').length);

	let refreshing = $state(false);
	let busyAction = $state<'up' | 'watch' | null>(null);

	$effect(() => {
		if (!visibleProjects.length) {
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

		try {
			await pingServer(uiState);
			const result = await refreshProjectsFromServer(uiState);
			hydrateProjects(result.projects, result.services);
			setConnectionState('connected', 'Compose API reachable and synchronized.');

			if (selectedProjectId) {
				appendLog(selectedProjectId, 'ok', 'Refreshed project list from the Compose API.');
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Server unavailable';
			setConnectionState('demo', `Compose API offline; seeded state retained (${message}).`);

			if (selectedProjectId) {
				appendLog(selectedProjectId, 'warn', 'Compose API unavailable; showing the seeded preview.');
			}
		} finally {
			refreshing = false;
		}
	}

	async function handleUp() {
		if (!selectedProject || !uiState) {
			return;
		}

		busyAction = 'up';
		setProjectState(selectedProject.id, 'running');

		try {
			await startProject(uiState, selectedProject.path, selectedProject.watch);
			setConnectionState('connected', `Started ${selectedProject.name}.`);
			appendLog(selectedProject.id, 'ok', `Started ${selectedProject.name} via /up.`);
		} catch {
			setConnectionState('demo', `Simulated start for ${selectedProject.name}; server not reachable.`);
			appendLog(selectedProject.id, 'info', `Simulated start for ${selectedProject.name}.`);
		} finally {
			busyAction = null;
		}
	}

	async function handleWatchToggle() {
		if (!selectedProject || !uiState) {
			return;
		}

		const nextWatch = !selectedProject.watch;
		busyAction = 'watch';
		setProjectWatch(selectedProject.id, nextWatch);

		try {
			if (nextWatch) {
				await startWatch(uiState, selectedProject.id, selectedProject.path);
				appendLog(selectedProject.id, 'ok', `Watch started for ${selectedProject.name}.`);
			} else {
				await stopWatch(uiState, selectedProject.id);
				appendLog(selectedProject.id, 'info', `Watch stopped for ${selectedProject.name}.`);
			}

			setConnectionState('connected', `${nextWatch ? 'Watch attached to' : 'Watch removed from'} ${selectedProject.name}.`);
		} catch {
			setConnectionState(
				'demo',
				`${nextWatch ? 'Watch enabled' : 'Watch disabled'} locally for ${selectedProject.name}.`
			);
			appendLog(
				selectedProject.id,
				nextWatch ? 'ok' : 'info',
				`${nextWatch ? 'Local watch attached' : 'Local watch removed'} for ${selectedProject.name}.`
			);
		} finally {
			busyAction = null;
		}
	}

	function methodTone(method: string) {
		if (method === 'POST') {
			return 'method-post';
		}

		if (method === 'DELETE') {
			return 'method-delete';
		}

		if (method === 'HEAD') {
			return 'method-head';
		}

		return 'method-get';
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

			<div class="toolbar">
				<button class="icon-button" type="button" aria-label="Refresh" onclick={refresh}>
					<Icon name="refresh" class={refreshing ? 'spinning' : ''} />
				</button>
				<button class="icon-button" type="button" aria-label="Search">
					<Icon name="search" />
				</button>
				<button class="icon-button" type="button" aria-label="Filter">
					<Icon name="sliders" />
				</button>
				<button class="icon-button" type="button" aria-label="Settings">
					<Icon name="gear" />
				</button>
			</div>
		</header>

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
							onclick={() => setProjectExpanded(project.id, !project.expanded)}
						>
							<Icon name="chevron" class={project.expanded ? 'rotated' : ''} />
						</button>

						<button class="project-button" type="button" onclick={() => selectProject(project.id)}>
							<span class="project-name">
								<Icon name="container" size={13} />
								{project.name}
							</span>
							<span class="project-meta">{project.updatedLabel}</span>
						</button>
					</div>

					{#if project.expanded}
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
		</div>
	</aside>

	<main class="panel">
		<header class="panel-header">
			<div class="panel-heading">
				<div class="status-line">
					<span class:connected={uiState?.status === 'connected'} class="status-dot"></span>
					<span class="status-copy">{uiState?.statusDetail}</span>
				</div>
				<h2>{selectedProject?.name ?? 'Compose Projects'}</h2>
			</div>

			<div class="action-row">
				<button
					class="ghost-button"
					type="button"
					onclick={handleUp}
					disabled={!selectedProject || busyAction !== null}
				>
					{busyAction === 'up' ? 'Starting…' : 'Up'}
				</button>
				<button
					class="ghost-button"
					type="button"
					onclick={handleWatchToggle}
					disabled={!selectedProject || busyAction !== null}
				>
					{busyAction === 'watch' ? 'Working…' : selectedProject?.watch ? 'Stop Watch' : 'Watch'}
				</button>
				<button class="ghost-button" type="button" onclick={refresh} disabled={refreshing}>
					{refreshing ? 'Syncing…' : 'Refresh'}
				</button>
			</div>
		</header>

		<section class="control-bar">
			<label>
				<span>Server</span>
				<div class="field">
					<Icon name="link" size={13} />
					<input
						type="text"
						value={uiState?.serverUrl ?? ''}
						onchange={(event) =>
							updateUiState({ serverUrl: (event.currentTarget as HTMLInputElement).value })}
						placeholder="http://127.0.0.1:8080"
					/>
				</div>
			</label>

			<label>
				<span>API</span>
				<div class="field small">
					<input
						type="text"
						value={uiState?.apiVersion ?? '1'}
						onchange={(event) =>
							updateUiState({ apiVersion: (event.currentTarget as HTMLInputElement).value })}
						placeholder="1"
					/>
				</div>
			</label>
		</section>

		<div class="content-grid">
			<section class="card summary-card">
				<div class="card-header">
					<div>
						<p class="eyebrow">Project</p>
						<h3>{selectedProject?.path ?? apiSchema.config.rootDir}</h3>
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
						<span class="metric-label">Routes</span>
						<strong>{apiRoutes.length}</strong>
					</div>
					<div class="metric">
						<span class="metric-label">Max Depth</span>
						<strong>{apiSchema.config.maxDepth}</strong>
					</div>
				</div>

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
			</section>

			<section class="card routes-card">
				<div class="card-header">
					<div>
						<p class="eyebrow">API Surface</p>
						<h3>{apiSchema.versionMatcher}</h3>
					</div>
					<div class="excluded">
						Excluded: {apiSchema.config.excludedDirs.join(', ')}
					</div>
				</div>

				<div class="route-groups">
					{#each routeGroups as group (group.title)}
						<div class="route-group">
							<div class="route-group-title">{group.title}</div>
							{#each group.routes as route (`${route.method}-${route.path}`)}
								<div class="route-row">
									<div class="route-main">
										<span class={`method-chip ${methodTone(route.method)}`}>{route.method}</span>
										<code>{route.path}</code>
									</div>
									<div class="route-summary">{route.summary}</div>
								</div>
							{/each}
						</div>
					{/each}
				</div>
			</section>

			<section class="card log-card">
				<div class="card-header">
					<div>
						<p class="eyebrow">Watch Output</p>
						<h3>{selectedProject?.name ?? 'No project selected'}</h3>
					</div>
					<div class="log-hint">SSE ready through <code>/watch/{'{project}'}</code></div>
				</div>

				<div class="log-list">
					{#each selectedLogs as entry (entry.id)}
						<div class="log-row">
							<span class={`log-level log-${entry.level}`}>{entry.level}</span>
							<span class="log-time">{entry.time}</span>
							<span class="log-message">{entry.message}</span>
						</div>
					{/each}
				</div>
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
		padding: 0.95rem 1rem 0.65rem;
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

	.toolbar,
	.action-row,
	.pill-row {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	.icon-button,
	.ghost-button,
	.toggle,
	.project-button {
		border: 0;
		background: transparent;
		color: inherit;
	}

	.icon-button,
	.toggle {
		display: grid;
		height: 1.7rem;
		width: 1.7rem;
		place-items: center;
		border-radius: 0.45rem;
		color: #95a3b6;
	}

	.icon-button:hover,
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

	.search input,
	.field input {
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

	.ghost-button {
		border-radius: 0.55rem;
		border: 1px solid rgba(126, 143, 166, 0.18);
		background: rgba(18, 24, 33, 0.72);
		padding: 0.48rem 0.72rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: #d9e3ef;
	}

	.ghost-button:hover:enabled {
		border-color: rgba(154, 173, 198, 0.26);
		background: rgba(25, 34, 46, 0.9);
	}

	.ghost-button:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.control-bar {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 7rem;
		gap: 0.85rem;
		padding: 0.95rem 0 1rem;
	}

	.control-bar label {
		display: grid;
		gap: 0.4rem;
		font-size: 0.74rem;
		font-weight: 600;
		color: #94a3b8;
		text-transform: uppercase;
		letter-spacing: 0.07em;
	}

	.field {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		border: 1px solid rgba(120, 138, 162, 0.18);
		border-radius: 0.6rem;
		background: rgba(10, 14, 19, 0.78);
		padding: 0 0.7rem;
	}

	.field.small {
		padding-inline: 0.8rem;
	}

	.content-grid {
		display: grid;
		flex: 1;
		grid-template-columns: minmax(0, 1.1fr) minmax(18rem, 0.9fr);
		grid-template-areas:
			'summary routes'
			'logs routes';
		gap: 0.9rem;
		min-height: 0;
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

	.routes-card {
		grid-area: routes;
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
	.excluded,
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
	.route-groups,
	.log-list {
		display: flex;
		min-height: 0;
		flex-direction: column;
		gap: 0.15rem;
		overflow: auto;
	}

	.compact-row,
	.route-row,
	.log-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		border-radius: 0.65rem;
		padding: 0.55rem 0.65rem;
		background: rgba(255, 255, 255, 0.015);
	}

	.row-tail,
	.route-main {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		font-size: 0.77rem;
		color: #9aacbf;
	}

	.state-chip,
	.method-chip {
		border-radius: 999px;
		padding: 0.18rem 0.48rem;
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.state-chip {
		background: rgba(123, 84, 84, 0.2);
		color: #ffb6b6;
	}

	.method-chip {
		min-width: 3.2rem;
		text-align: center;
	}

	.method-get {
		background: rgba(65, 111, 182, 0.2);
		color: #a8c9ff;
	}

	.method-post {
		background: rgba(68, 132, 88, 0.2);
		color: #b9efc9;
	}

	.method-delete {
		background: rgba(148, 79, 79, 0.22);
		color: #ffc0c0;
	}

	.method-head {
		background: rgba(126, 105, 62, 0.22);
		color: #f1d298;
	}

	.route-group + .route-group {
		margin-top: 0.55rem;
	}

	.route-group-title {
		margin: 0 0 0.35rem 0.15rem;
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #8393a8;
	}

	.route-row {
		flex-direction: column;
		align-items: stretch;
	}

	.route-summary {
		font-size: 0.78rem;
		color: #b0bccd;
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

	code {
		font-family:
			'JetBrains Mono', 'SFMono-Regular', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
			monospace;
		font-size: 0.76rem;
		color: #dce6f4;
	}

	.rotated {
		transform: rotate(90deg);
	}

	.spinning {
		animation: spin 0.9s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 1100px) {
		.content-grid {
			grid-template-columns: 1fr;
			grid-template-areas:
				'summary'
				'routes'
				'logs';
		}
	}

	@media (max-width: 820px) {
		.workspace {
			grid-template-columns: 1fr;
		}

		.sidebar {
			max-height: 24rem;
			border-right: 0;
			border-bottom: 1px solid rgba(129, 146, 170, 0.16);
		}

		.control-bar,
		.metrics {
			grid-template-columns: 1fr;
		}

		.panel-header {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
