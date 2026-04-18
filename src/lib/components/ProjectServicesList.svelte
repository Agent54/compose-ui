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
		onOpenContextMenu: (event: MouseEvent, project: ComposeProject, service: ComposeService) => void;
		onPauseToggle: (project: ComposeProject, service: ComposeService) => void;
		onWatchingToggle: (project: ComposeProject) => void;
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
		return service.state !== 'uncreated';
	}

	function startButtonSpinning(service: ComposeService) {
		return (
			buildingServiceId === service.id ||
			busyAction === `start:${project.id}:${service.id}` ||
			busyAction === `up-no-build:${project.id}:${service.id}`
		);
	}

	function serviceRowTooltipText(service: ComposeService) {
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
						<span class="service-title">{service.serviceName}</span>
						{#if shouldShowServiceStatus(service)}
							<span class="service-status">
								{service.stateText}
								{#if service.health}
									<span class="health-tag">({service.health})</span>
								{/if}
							</span>
						{/if}
					</div>
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
								name={service.state === 'running' || service.state === 'paused' ? 'stop' : 'play'}
								size={13}
							/>
						</button>
					</span>

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
								onWatchingToggle(project);
							}}
							disabled={busyAction !== null}
						>
							<Icon name={project.watching ? 'eye-off' : 'eye'} size={13} />
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
		background: rgba(255, 255, 255, 0.05);
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
		padding: 0.08rem 3.9rem 0.08rem 0;
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
		color: #7b8087;
	}

	.service-state-created {
		color: #97a2ad;
	}

	.service-state-unknown {
		color: #a8afb8;
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
		font-weight: 600;
		color: #eef0f2;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.service-status {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		color: #969ca5;
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
		border: 1px solid rgba(255, 255, 255, 0.11);
		background: rgba(10, 10, 11, 0.98);
		color: #d5d9de;
		box-shadow: 0 10px 22px rgba(0, 0, 0, 0.32);
		cursor: pointer;
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
		border: 1px solid rgba(255, 255, 255, 0.22);
		border-radius: 0.45rem;
		background: #050607 !important;
		box-shadow: 0 14px 34px rgba(0, 0, 0, 0.68);
		color: #eef1f4;
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
		border: 1px solid rgba(255, 255, 255, 0.22);
		border-radius: 0.45rem;
		background: #050607;
		box-shadow: 0 14px 34px rgba(0, 0, 0, 0.68);
		color: #eef1f4;
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
		background: rgba(255, 255, 255, 0.015);
		font-size: 0.74rem;
		color: #9aa1aa;
	}

	.service-row-loading {
		padding-right: 0.5rem;
	}

	.service-button-loading {
		padding-right: 0;
		cursor: default;
	}

	.service-state-loading {
		color: #8f969f;
	}
</style>
