<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	let {
		label,
		description = '',
		children,
		onclick,
		type = 'button',
		disabled = false,
		placement = 'top',
		tone = 'muted',
		align = 'end',
		badge = false
	}: {
		label: string;
		description?: string;
		children?: Snippet;
		onclick?: () => void;
		type?: 'button' | 'submit';
		disabled?: boolean;
		placement?: 'top' | 'bottom';
		tone?: 'muted' | 'info' | 'success' | 'warning' | 'danger' | 'accent';
		align?: 'end' | 'center';
		badge?: boolean;
	} = $props();
	const uid = $props.id();
	let dismissed = $state(false);
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape') dismissed = true;
	}}
/>

<span class="action" class:dismissed data-placement={placement} data-align={align}>
	<button
		{type}
		class:badge
		data-tone={tone}
		aria-label={label}
		aria-describedby={uid}
		{disabled}
		{onclick}
		onpointerenter={() => {
			dismissed = false;
		}}
		onfocus={() => {
			dismissed = false;
		}}
	>
		{#if children}{@render children()}{:else}<Icon name="info" size={15} stroke={1.7} />{/if}
	</button>
	<span class="tooltip" id={uid} role="tooltip"
		><strong>{label}</strong>{#if description}<span>{description}</span>{/if}</span
	>
</span>

<style>
	.action {
		position: relative;
		display: inline-flex;
		flex: none;
		vertical-align: middle;
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 5px;
		background: transparent;
		color: var(--shell-muted);
		cursor: pointer;
	}
	button:hover:enabled {
		background: var(--shell-hover);
		color: var(--shell-text);
	}
	button:focus-visible {
		outline: 2px solid var(--shell-accent);
		outline-offset: 2px;
	}
	button:disabled {
		opacity: 0.35;
		cursor: default;
	}
	button[data-tone='info'] {
		color: var(--shell-info);
	}
	button[data-tone='success'] {
		color: var(--shell-success);
	}
	button[data-tone='warning'] {
		color: var(--shell-warning);
	}
	button[data-tone='accent'] {
		border-color: var(--shell-border);
		background: var(--shell-active);
		color: var(--shell-text);
	}
	button[data-tone='accent']:hover:enabled {
		border-color: var(--shell-focus);
		background: var(--shell-hover);
	}
	button[data-tone='accent']:disabled {
		background: transparent;
		border: 1px solid var(--shell-border);
		color: var(--shell-muted);
	}
	button[data-tone='danger']:hover:enabled {
		background: color-mix(in srgb, var(--shell-danger) 12%, transparent);
		color: var(--shell-danger);
	}
	button.badge {
		width: auto;
		height: 1.25rem;
		padding: 0 0.375rem;
		font-family: inherit;
		font-size: 10px;
		font-weight: 500;
		border: 1px solid var(--shell-border);
		background: var(--shell-raised);
	}
	.tooltip {
		display: none;
		position: absolute;
		bottom: calc(100% + 8px);
		right: 0;
		z-index: 30;
		width: max-content;
		max-width: min(16rem, calc(100vw - 2rem));
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--shell-border);
		border-radius: 7px;
		background: var(--shell-raised);
		box-shadow: 0 4px 16px #0005;
		color: var(--shell-text);
		text-align: left;
		white-space: normal;
		font:
			12px/1.5 -apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			sans-serif;
	}
	.tooltip::after {
		content: '';
		position: absolute;
		top: 100%;
		left: 0;
		width: 100%;
		height: 10px;
	}
	.tooltip strong {
		display: block;
		font-weight: 500;
	}
	.tooltip > span {
		display: block;
		margin-top: 0.3rem;
		color: var(--shell-muted);
	}
	.action:not(.dismissed):hover .tooltip,
	.action:not(.dismissed):focus-within .tooltip {
		display: block;
	}
	.action[data-placement='bottom'] .tooltip {
		top: calc(100% + 8px);
		bottom: auto;
	}
	.action[data-placement='bottom'] .tooltip::after {
		top: auto;
		bottom: 100%;
	}
	.action[data-align='center'] .tooltip {
		right: 50%;
		transform: translateX(50%);
	}
</style>
