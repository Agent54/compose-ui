<script lang="ts">
	import { eq } from '@tanstack/db';
	import { useLiveQuery } from '@tanstack/svelte-db';

	import Icon from '$lib/components/Icon.svelte';
	import { servicesCollection, type ComposeProject, type ComposeService } from '$lib/central';

	let {
		project,
		selectedContainerId,
		busyAction,
		onContainerSelect,
		onStartStop,
		onOpenContextMenu,
		onPauseToggle,
		onWatchingToggle
	}: {
		project: ComposeProject;
		selectedContainerId: string;
		busyAction: string | null;
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
				.where(({ services }) => eq(services.projectId, project.id))
				.orderBy(({ services }) => services.serviceName)
				.orderBy(({ services }) => services.containerName),
		[() => project.id]
	);

	const services = $derived((servicesQuery.data ?? []) as ComposeService[]);

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
</script>

<div class="service-list">
	{#if services.length}
		{#each services as service (service.id)}
			<div class:selected={selectedContainerId === service.id} class="service-row">
				<button
					class="service-button"
					type="button"
					aria-label={`Select ${service.serviceName}`}
					oncontextmenu={(event) => onOpenContextMenu(event, project, service)}
					onmousedown={() => onContainerSelect(project.id, service.id)}
				>
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
				</button>

				<div class="row-actions">
					<button
						class="overlay-button"
						type="button"
						aria-label={`${service.state === 'running' || service.state === 'paused' ? 'Stop' : 'Start'} ${service.serviceName}`}
						title={`${service.state === 'running' || service.state === 'paused' ? 'Stop' : 'Start'} ${service.serviceName}`}
						onmousedown={() => onStartStop(project, service)}
						disabled={busyAction !== null}
					>
						<Icon
							name={service.state === 'running' || service.state === 'paused' ? 'stop' : 'play'}
							size={13}
						/>
					</button>

					{#if service.state === 'running' || service.state === 'paused'}
						<button
							class="overlay-button"
							type="button"
							aria-label={`${service.state === 'paused' ? 'Unpause' : 'Pause'} ${service.serviceName}`}
							title={`${service.state === 'paused' ? 'Unpause' : 'Pause'} ${service.serviceName}`}
							onmousedown={() => onPauseToggle(project, service)}
							disabled={busyAction !== null}
						>
							<Icon name={service.state === 'paused' ? 'play' : 'pause'} size={13} />
						</button>
					{/if}

					<button
						class="overlay-button"
						type="button"
						aria-label={`${project.watching ? 'Stop watching' : 'Watch'} ${service.serviceName}`}
						title={`${project.watching ? 'Stop watching' : 'Watch'} ${service.serviceName}`}
						onmousedown={() => onWatchingToggle(project)}
						disabled={busyAction !== null}
					>
						<Icon name="eye" size={13} />
					</button>
				</div>
			</div>
		{/each}
	{:else if servicesQuery.isLoading || !servicesQuery.isReady}
		<div class="service-empty">Loading containers…</div>
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
		padding: 0.24rem 0;
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
		color: #7b8087;
	}

	.service-copy {
		min-width: 0;
		font-size: 0.8rem;
	}

	.service-title {
		display: flex;
		gap: 0.35rem;
		font-weight: 600;
		color: #eef0f2;
	}

	.service-container {
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
</style>
