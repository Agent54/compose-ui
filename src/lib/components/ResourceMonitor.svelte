<script lang="ts">
	import { resourcePressure, type ResourcePressure } from '$lib/central/resource-state';

	let {
		groups
	}: {
		groups: Array<{
			label: string;
			metrics: Array<{
				label: string;
				value: string;
				tooltip: string;
				percent?: number;
				pressure?: ResourcePressure;
			}>;
		}>;
	} = $props();
	const uid = $props.id();
	let root: HTMLDivElement | undefined;
	let dismissed = $state(false);
	let pinned = $state(false);
	let pressedAt: number | undefined;
	const pressure = $derived.by(() => {
		const pressures = groups.flatMap((group) =>
			group.metrics.map((metric) => metric.pressure ?? resourcePressure(metric.percent))
		);
		return pressures.includes('critical')
			? 'critical'
			: pressures.includes('warning')
				? 'warning'
				: 'normal';
	});

	function dismiss() {
		dismissed = true;
		pinned = false;
		pressedAt = undefined;
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape') dismiss();
	}}
	onpointerdown={(event) => {
		if (!root?.contains(event.target as Node)) dismiss();
	}}
	onpointerup={() => {
		if (pressedAt !== undefined && performance.now() - pressedAt >= 500) dismiss();
		pressedAt = undefined;
	}}
	onpointercancel={dismiss}
	onblur={dismiss}
/>

<div
	class="monitor"
	class:dismissed
	class:pinned
	{@attach (element) => {
		root = element;
		return () => {
			root = undefined;
		};
	}}
>
	<button
		type="button"
		aria-label={`Resource monitoring: ${pressure}`}
		aria-describedby={uid}
		onpointerenter={() => {
			dismissed = false;
		}}
		onfocus={() => {
			dismissed = false;
		}}
		onblur={() => {
			pinned = false;
		}}
		onpointerdown={(event) => {
			if (event.button !== 0 || !event.isPrimary) return;
			event.preventDefault();
			event.currentTarget.focus();
			if (pinned) dismiss();
			else {
				dismissed = false;
				pinned = true;
				pressedAt = performance.now();
			}
		}}
		onclick={(event) => {
			if (event.detail !== 0) return;
			if (pinned) dismiss();
			else {
				dismissed = false;
				pinned = true;
			}
		}}
	>
		<span class="dot" data-pressure={pressure} aria-hidden="true"></span>
	</button>
	<div class="popover" id={uid} role="tooltip">
		{#each groups as group (group.label)}
			<section aria-label={group.label}>
				<h3>{group.label}</h3>
				<dl>
					{#each group.metrics as metric (metric.label)}
						<div class="metric" title={metric.tooltip}>
							<dt>
								<span
									class="dot"
									data-pressure={metric.pressure ?? resourcePressure(metric.percent)}
									aria-hidden="true"
								></span>
								{metric.label}
							</dt>
							<dd>{metric.value}</dd>
						</div>
					{/each}
				</dl>
			</section>
		{/each}
	</div>
</div>

<style>
	.monitor {
		position: relative;
		display: inline-flex;
		flex: none;
	}
	button {
		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		border: 0;
		border-radius: 0.35rem;
		background: transparent;
		cursor: pointer;
	}
	button:hover {
		background: var(--app-control-hover);
	}
	button:focus-visible {
		outline: 2px solid var(--app-text-muted);
		outline-offset: 2px;
	}
	.dot {
		width: 0.45rem;
		height: 0.45rem;
		flex: none;
		border-radius: 50%;
		background: #67bf91;
	}
	.dot[data-pressure='warning'] {
		background: #d9a441;
	}
	.dot[data-pressure='critical'] {
		background: #dc625f;
	}
	.popover {
		display: none;
		position: absolute;
		top: 100%;
		right: 0;
		z-index: 30;
		width: min(19rem, calc(100vw - 1.5rem));
		max-height: calc(100dvh - 4rem);
		overflow: auto;
		padding: 0.75rem;
		border: 1px solid var(--app-border-strong);
		border-radius: 0.5rem;
		background: var(--app-bg);
		box-shadow: 0 4px 16px #0005;
		color: var(--app-text);
		font-size: 0.7rem;
	}
	.monitor:not(.dismissed):hover .popover,
	.monitor:not(.dismissed):focus-within .popover,
	.monitor.pinned .popover {
		display: block;
	}
	section + section {
		margin-top: 0.75rem;
	}
	h3 {
		margin: 0 0 0.4rem;
		color: var(--app-text-subtle);
		font-size: 0.65rem;
		text-transform: uppercase;
	}
	dl {
		margin: 0;
	}
	.metric {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.2rem 0;
	}
	dt {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		color: var(--app-text-muted);
	}
	dd {
		margin: 0;
		text-align: right;
		font-weight: 700;
	}
</style>
