<script lang="ts">
	import { onMount } from 'svelte';
	import { runtimeMemoryWarning } from '$lib/central/resource-state';
	import type { RuntimeStatus } from '$lib/central/types';

	let { runtime }: { runtime: RuntimeStatus | null } = $props();
	let dismissedId = $state('');
	const storageKey = 'xe.runtime.dismissedMemoryIncident';
	const warning = $derived(runtimeMemoryWarning(runtime, dismissedId));

	onMount(() => {
		try {
			dismissedId = localStorage.getItem(storageKey) ?? '';
		} catch {
			/* Storage is optional. */
		}
	});

	function dismiss() {
		if (!warning?.id) return;
		dismissedId = warning.id;
		try {
			localStorage.setItem(storageKey, dismissedId);
		} catch {
			/* Keep this session's dismissal. */
		}
	}
</script>

{#if warning}
	<div class="memory-warning" role="alert">
		<div>
			<strong>{warning.title}</strong>
			{#if warning.occurredAt}
				<time datetime={warning.occurredAt}>{new Date(warning.occurredAt).toLocaleString()}</time>
			{/if}
			<p>{warning.message}</p>
			{#if warning.memoryLimitBytes}
				<small
					>VM memory limit{warning.occurredAt ? ' at this event' : ''}: {Math.round(
						(warning.memoryLimitBytes / 2 ** 30) * 10
					) / 10} GiB</small
				>
			{/if}
		</div>
		{#if warning.id}<button type="button" onclick={dismiss}>Dismiss</button>{/if}
	</div>
{/if}

<style>
	.memory-warning {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: 16px;
		margin: 12px 16px 0;
		padding: 12px 16px;
		border: 1px solid #a65353;
		border-radius: 8px;
		background: #2a1b1b;
		color: #f4d5d5;
	}
	strong {
		font-size: 14px;
	}
	time,
	small {
		display: block;
		margin-top: 4px;
		font-size: 12px;
		color: #d3afaf;
	}
	p {
		margin: 6px 0;
		font-size: 13px;
	}
	button {
		flex-shrink: 0;
		padding: 4px 8px;
		border: 1px solid #8c5c5c;
		border-radius: 4px;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	button:focus-visible {
		outline: 2px solid currentColor;
		outline-offset: 3px;
	}
</style>
