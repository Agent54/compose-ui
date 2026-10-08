<script lang="ts">
	import { base } from '$app/paths';
	import Icon from './Icon.svelte';
	import { shellHref, type ShellConfig, type ShellTarget } from '$lib/shell/launch';

	let {
		config,
		target,
		label,
		compact = false,
		disabled = false
	}: {
		config: ShellConfig | null | undefined;
		target: ShellTarget;
		label: string;
		compact?: boolean;
		disabled?: boolean;
	} = $props();

	function openShell(event: MouseEvent) {
		if (!event.metaKey || !config || disabled) return;
		event.preventDefault();
		window.open(shellHref(base, config, target, true), '_blank', 'noopener,noreferrer');
	}
</script>

<a
	class="shell-link"
	class:compact
	href={config && !disabled ? shellHref(base, config, target) : undefined}
	target="_blank"
	rel="external noopener noreferrer"
	onclick={openShell}
	aria-label={`${label} in a new tab`}
	title={`${label} in a new tab · ⌘-click for a new session`}
	aria-disabled={disabled || !config}
	data-tooltip={`${label} in a new tab`}
>
	<Icon name="terminal" size={compact ? 13 : 14} />
	{#if !compact}<span>VM Shell</span>{/if}
</a>

<style>
	.shell-link {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		min-height: 1.8rem;
		padding: 0.3rem 0.55rem;
		border: 1px solid var(--app-border-strong);
		border-radius: 0.5rem;
		background: var(--app-surface-raised);
		color: var(--app-text-muted);
		font-size: 0.72rem;
		font-weight: 600;
		text-decoration: none;
		white-space: nowrap;
	}
	.compact {
		width: 1.7rem;
		height: 1.7rem;
		min-height: 0;
		padding: 0;
	}
	.shell-link:hover,
	.shell-link:focus-visible {
		background: var(--app-surface-hover);
		color: var(--app-text);
		border-color: #7fc4ea;
	}
	.shell-link[aria-disabled='true'] {
		opacity: 0.45;
		pointer-events: none;
	}
</style>
