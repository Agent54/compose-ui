<script lang="ts">
	import { onMount } from 'svelte';
	import type { RuntimeCachePressureWarning } from '$lib/central/types';

	let { warning }: { warning: RuntimeCachePressureWarning | undefined } = $props();
	let dismissedId = $state('');
	const storageKey = 'xe.runtime.dismissedCachePressureWarning';
	const visible = $derived(warning && warning.id !== dismissedId ? warning : undefined);

	onMount(() => {
		try {
			dismissedId = localStorage.getItem(storageKey) ?? '';
		} catch {
			/* Storage is optional. */
		}
	});

	function dismiss() {
		if (!visible) return;
		dismissedId = visible.id;
		try {
			localStorage.setItem(storageKey, dismissedId);
		} catch {
			/* Keep this session's dismissal. */
		}
	}
</script>

{#if visible}
	<div class="cache-warning" role="alert">
		<div>
			<strong>VM disk space is low</strong>
			<time datetime={visible.occurredAt}>{new Date(visible.occurredAt).toLocaleString()}</time>
			<p>{visible.message}</p>
		</div>
		<button type="button" aria-label="Dismiss low disk space warning" onclick={dismiss}
			>Dismiss</button
		>
	</div>
{/if}

<style>
	.cache-warning {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: 16px;
		margin: 12px 16px 0;
		padding: 12px 16px;
		border: 1px solid #a98135;
		border-radius: 8px;
		background: #302716;
		color: #ffe3a6;
	}
	strong {
		font-size: 14px;
	}
	time {
		display: block;
		margin-top: 4px;
		font-size: 12px;
		color: #dbc38f;
	}
	p {
		margin: 6px 0;
		font-size: 13px;
	}
	button {
		flex-shrink: 0;
		padding: 4px 8px;
		border: 1px solid #a98135;
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
