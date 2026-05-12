<script lang="ts">
	import { eq } from '@tanstack/db';
	import { useLiveQuery } from '@tanstack/svelte-db';

	import Icon from '$lib/components/Icon.svelte';
	import { servicesCollection, type ComposeProject, type ComposeService } from '$lib/central';

	let {
		project,
		selectedContainerId,
		busyAction,
		buildingServiceId,
		sortBy,
		refreshEpoch,
		onContainerSelect,
		onStartStop,
		onRestart,
		onOpenContextMenu,
		onPauseToggle,
		onWatchingToggle
	}: {
		project: ComposeProject;
		selectedContainerId: string;
		busyAction: string | null;
		buildingServiceId?: string;
		sortBy: 'path' | 'name' | 'status';
		refreshEpoch: number;
		onContainerSelect: (projectId: string, serviceId: string) => void;
		onStartStop: (project: ComposeProject, service: ComposeService) => void;
		onRestart: (project: ComposeProject, service: ComposeService) => void;
		onOpenContextMenu: (event: MouseEvent, project: ComposeProject, service: ComposeService) => void;
		onPauseToggle: (project: ComposeProject, service: ComposeService) => void;
		onWatchingToggle: (project: ComposeProject, service?: ComposeService) => void;
	} = $props();

	const servicesQuery = useLiveQuery(
		(q) =>
			q
				.from({ services: servicesCollection })
				.where(({ services }) => eq(services.projectId, project.id)),
		[() => project.id, () => refreshEpoch]
	);

	function stateRank(state: ComposeService['state']) {
		if (state === 'running') return 0;
		if (state === 'paused') return 1;
		if (state === 'exited') return 2;
		if (state === 'created') return 3;
		if (state === 'unknown') return 4;
		if (state === 'uncreated') return 5;
		return 6;
	}

	const services = $derived.by(() => {
		const entries = [...((servicesQuery.data ?? []) as ComposeService[])];

		return entries.sort((left, right) => {
			if (sortBy === 'status') {
				return (
					stateRank(left.state) - stateRank(right.state) ||
					left.serviceName.localeCompare(right.serviceName) ||
					left.containerName.localeCompare(right.containerName)
				);
			}

			return (
				left.serviceName.localeCompare(right.serviceName) ||
				left.containerName.localeCompare(right.containerName)
			);
		});
	});

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

		if (service.state === 'created') {
			return 'service-state-created';
		}

		if (service.state === 'unknown') {
			return 'service-state-unknown';
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

		if (service.state === 'created') {
			return 'container';
		}

		if (service.state === 'unknown') {
			return 'pulse';
		}

		return 'stop';
	}

	function shouldShowServiceStatus(service: ComposeService) {
		return Boolean(servicePendingStatusLabel(service)) || service.state !== 'uncreated';
	}

	function startButtonSpinning(service: ComposeService) {
		return (
			buildingServiceId === service.id ||
			busyAction === `stop:${project.id}:${service.id}` ||
			busyAction === `start:${project.id}:${service.id}` ||
			busyAction === `up-no-build:${project.id}:${service.id}` ||
			busyAction === `restart:${project.id}:${service.id}` ||
			busyAction === `watching:${project.id}:${service.id}` ||
			busyAction === `remove:${project.id}:${service.id}`
		);
	}

	function servicePendingStatusLabel(service: ComposeService) {
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

		if (buildingServiceId === service.id) {
			return 'building';
		}

		return '';
	}

	function serviceDisplayStatusLabel(service: ComposeService) {
		return servicePendingStatusLabel(service) || service.stateText;
	}

	function serviceRowTooltipText(service: ComposeService) {
		const pendingStatus = servicePendingStatusLabel(service);

		if (pendingStatus) {
			return `${service.containerName}\n${pendingStatus}`;
		}

		return service.health
			? `${service.containerName}\n${service.stateText} (${service.health})`
			: `${service.containerName}\n${service.stateText}`;
	}

	function isPrimaryMouse(event: MouseEvent) {
		return event.button === 0 && !event.ctrlKey;
	}
</script>

<div class="service-list">
	{#if services.length}
		{#each services as service (service.id)}
			<div class:selected={selectedContainerId === service.id} class="service-row">
				<button
					class="service-button row-tooltip-trigger"
					type="button"
					aria-label={`Select ${service.serviceName}`}
					oncontextmenu={(event) => onOpenContextMenu(event, project, service)}
					onmousedown={(event) => {
						if (!isPrimaryMouse(event)) return;
						onContainerSelect(project.id, service.id);
					}}
				>
					<span class={`service-state ${serviceStateTone(service)}`}>
						<Icon
							name={startButtonSpinning(service) ? 'refresh' : serviceStateIcon(service)}
							size={13}
							spinning={startButtonSpinning(service)}
						/>
					</span>
					<div class="service-copy">
						<span class="service-title">
							<span class="service-title-text">{service.serviceName}</span>
						</span>
						{#if shouldShowServiceStatus(service)}
							<span class="service-status">
								{serviceDisplayStatusLabel(service)}
								{#if service.health && !servicePendingStatusLabel(service)}
									<span class="health-tag">({service.health})</span>
								{/if}
							</span>
						{/if}
					</div>
					<span class="service-meta">
						{#if project.watching}
							<span class="service-watch-indicator" aria-label="Watching">
								<Icon name="eye" size={12} />
							</span>
						{/if}
					</span>
				</button>
				<span class="row-tooltip-bubble" aria-hidden="true">{serviceRowTooltipText(service)}</span>

				<div class="row-actions">
					<span
						class="tooltip-anchor"
						data-tooltip={`${service.state === 'running' || service.state === 'paused' ? 'Stop' : 'Start'} ${service.serviceName}`}
					>
						<button
							class="overlay-button"
							type="button"
							aria-label={`${service.state === 'running' || service.state === 'paused' ? 'Stop' : 'Start'} ${service.serviceName}`}
							onmousedown={(event) => {
								if (!isPrimaryMouse(event)) return;
								onStartStop(project, service);
							}}
							disabled={busyAction !== null}
						>
							<Icon
								name={busyAction === `stop:${project.id}:${service.id}` ? 'refresh' : service.state === 'running' || service.state === 'paused' ? 'stop' : 'play'}
								size={13}
								spinning={busyAction === `stop:${project.id}:${service.id}`}
							/>
						</button>
					</span>

					{#if service.state === 'running' || service.state === 'paused'}
						<span
							class="tooltip-anchor"
							data-tooltip={`Restart ${service.serviceName}`}
						>
							<button
								class="overlay-button"
								type="button"
								aria-label={`Restart ${service.serviceName}`}
								onmousedown={(event) => {
									if (!isPrimaryMouse(event)) return;
									onRestart(project, service);
								}}
								disabled={busyAction !== null}
							>
								<Icon
									name="refresh"
									size={13}
									spinning={busyAction === `restart:${project.id}:${service.id}`}
								/>
							</button>
						</span>
					{/if}

					{#if service.state === 'paused'}
						<span
							class="tooltip-anchor"
							data-tooltip={`Start ${service.serviceName}`}
						>
							<button
								class="overlay-button"
								type="button"
								aria-label={`Start ${service.serviceName}`}
								onmousedown={(event) => {
									if (!isPrimaryMouse(event)) return;
									onPauseToggle(project, service);
								}}
								disabled={busyAction !== null}
							>
								<Icon name="play" size={13} />
							</button>
						</span>
					{/if}

					<span
						class="tooltip-anchor"
						data-tooltip={`${project.watching ? 'Stop watching' : 'Watch'} ${service.serviceName}`}
					>
						<button
							class="overlay-button"
							type="button"
							aria-label={`${project.watching ? 'Stop watching' : 'Watch'} ${service.serviceName}`}
							onmousedown={(event) => {
								if (!isPrimaryMouse(event)) return;
								onWatchingToggle(project, service);
							}}
							disabled={busyAction !== null}
						>
							<Icon
								name={busyAction === `watching:${project.id}:${service.id}` ? 'refresh' : project.watching ? 'eye-off' : 'eye'}
								size={13}
								spinning={busyAction === `watching:${project.id}:${service.id}`}
							/>
						</button>
					</span>
				</div>
			</div>
		{/each}
	{:else if servicesQuery.isLoading || !servicesQuery.isReady}
		<div class="service-row service-row-loading" aria-hidden="true">
			<div class="service-button service-button-loading">
				<span class="service-state service-state-loading">
					<Icon name="refresh" size={13} spinning={true} />
				</span>
			</div>
		</div>
	{:else}
		<div class="service-empty">No containers returned by /ps.</div>
	{/if}
</div>

<style>
	.service-list {
		margin-left: 1.9rem;
		padding: 0.08rem 0 0.28rem 0.68rem;
	}

	.service-row {
		position: relative;
		display: flex;
		gap: 0.58rem;
		padding: 0.28rem 0;
		overflow: visible;
		border-radius: 0.55rem;
	}

	.service-row.selected::before {
		content: '';
		position: absolute;
		inset: 0 0 0 -7px;
		border-radius: 0.55rem;
		background: var(--app-control-hover);
		pointer-events: none;
	}

	.service-button {
		position: relative;
		z-index: 1;
		display: flex;
		width: 100%;
		min-width: 0;
		align-items: center;
		gap: 0.58rem;
		padding: 0.08rem 0.42rem 0.08rem 0;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
		text-align: left;
	}

	.service-state {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: #c66c6b;
	}

	.service-state-running {
		color: #73c37f;
	}

	.service-state-paused {
		color: #7fc4ea;
	}

	.service-state-exited {
		color: #c66c6b;
	}

	.service-state-uncreated {
		color: var(--app-text-subtle);
	}

	.service-state-created {
		color: var(--app-text-muted);
	}

	.service-state-unknown {
		color: var(--app-text-muted);
	}

	.service-copy {
		display: flex;
		min-width: 0;
		align-items: baseline;
		gap: 0.42rem;
		font-size: 0.8rem;
		white-space: nowrap;
	}

	.service-title {
		display: inline-flex;
		min-width: 0;
		align-items: center;
		gap: 0.32rem;
		font-weight: 600;
		color: var(--app-text);
	}

	.service-title-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.service-watch-indicator {
		display: inline-flex;
		flex: none;
		color: #1d9bf0;
	}

	.service-meta {
		display: inline-flex;
		min-width: 1rem;
		flex: none;
		align-items: center;
		justify-content: flex-end;
		margin-left: auto;
		color: var(--app-text-muted);
		transition: opacity 120ms ease;
	}

	.service-row:hover .service-meta {
		opacity: 0;
	}

	.service-status {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--app-text-muted);
	}

	.health-tag {
		color: #7fe39a;
	}

	.row-actions {
		position: absolute;
		top: 50%;
		right: 0.32rem;
		z-index: 2;
		display: inline-flex;
		gap: 0.28rem;
		transform: translateY(-50%);
		opacity: 0;
		pointer-events: none;
		transition: opacity 120ms ease;
		z-index: 3;
	}

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
		border: 1px solid var(--app-border);
		background: var(--app-surface-raised);
		color: var(--app-text-muted);
		box-shadow: 0 10px 22px rgba(0, 0, 0, 0.32);
		cursor: pointer;
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
			opacity 120ms ease,
			transform 120ms ease,
			visibility 0s linear 140ms;
		z-index: 20;
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
		left: 0;
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
			opacity 120ms ease,
			transform 120ms ease,
			visibility 0s linear 140ms;
	}

	.row-tooltip-trigger:hover + .row-tooltip-bubble {
		opacity: 1;
		visibility: visible;
		transform: translateY(0);
		transition-delay: 650ms, 650ms, 650ms;
	}

	.service-row:has(.row-actions:hover) .row-tooltip-bubble {
		opacity: 0;
		visibility: hidden;
		transform: translateY(-2px);
		transition-delay: 0s, 0s, 0s;
	}

	.tooltip-anchor[data-tooltip]::after,
	[data-tooltip]:not([data-tooltip=''])::after {
		transform: translateY(-2px);
	}

	.service-empty {
		display: grid;
		place-items: center;
		margin-right: 0.5rem;
		min-height: 2.3rem;
		border-radius: 0.8rem;
		background: var(--app-control);
		font-size: 0.74rem;
		color: var(--app-text-muted);
	}

	.service-row-loading {
		padding-right: 0.5rem;
	}

	.service-button-loading {
		padding-right: 0;
		cursor: default;
	}

	.service-state-loading {
		color: var(--app-text-subtle);
	}
</style>
