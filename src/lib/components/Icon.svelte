<script lang="ts">
	type IconName =
		| 'chevron'
		| 'container'
		| 'dotted-circle'
		| 'eye'
		| 'eye-off'
		| 'pause'
		| 'play'
		| 'refresh'
		| 'search'
		| 'sort'
		| 'sliders'
		| 'stop'
		| 'gear'
		| 'pulse'
		| 'route'
		| 'link';

	let {
		name,
		size = 14,
		stroke = 2,
		rotated = false,
		spinning = false,
		class: className = ''
	}: {
		name: IconName;
		size?: number;
		stroke?: number;
		rotated?: boolean;
		spinning?: boolean;
		class?: string;
	} = $props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={stroke}
	stroke-linecap="round"
	stroke-linejoin="round"
	class={`${className} ${rotated ? 'rotated' : ''} ${spinning ? 'spinning' : ''}`.trim()}
	aria-hidden="true"
>
	{#if name === 'chevron'}
		<path d="m9 6 6 6-6 6" />
	{:else if name === 'container'}
		<path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5z" />
		<path d="M4 7.5 12 11l8-3.5" />
		<path d="M12 11v9" />
	{:else if name === 'dotted-circle'}
		<circle cx="12" cy="12" r="6" stroke-dasharray="1.5 2.5" />
	{:else if name === 'eye'}
		<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
		<circle cx="12" cy="12" r="2.5" />
	{:else if name === 'eye-off'}
		<path d="M3 3 21 21" />
		<path d="M10.6 10.7a2.5 2.5 0 0 0 2.7 2.7" />
		<path d="M9.4 5.1A10.7 10.7 0 0 1 12 4.8c6 0 9.5 7.2 9.5 7.2a17.2 17.2 0 0 1-3.1 4.1" />
		<path d="M6.2 6.2A17.8 17.8 0 0 0 2.5 12s3.5 7.2 9.5 7.2a10.9 10.9 0 0 0 4.1-.8" />
	{:else if name === 'play'}
		<path d="m8 6 10 6-10 6z" />
	{:else if name === 'pause'}
		<path d="M8 6v12" />
		<path d="M16 6v12" />
	{:else if name === 'stop'}
		<rect x="7" y="7" width="10" height="10" rx="0.75" fill="currentColor" stroke="none" />
	{:else if name === 'refresh'}
		<path d="M20 11a8 8 0 0 0-13.66-5.66" />
		<path d="M4 4v5h5" />
		<path d="M4 13a8 8 0 0 0 13.66 5.66" />
		<path d="M20 20v-5h-5" />
	{:else if name === 'search'}
		<circle cx="11" cy="11" r="6" />
		<path d="m20 20-3.5-3.5" />
	{:else if name === 'sort'}
		<path d="M7 6h10" />
		<path d="M10 12h7" />
		<path d="M13 18h4" />
	{:else if name === 'sliders'}
		<path d="M4 21v-7" />
		<path d="M4 10V3" />
		<path d="M12 21v-4" />
		<path d="M12 14V3" />
		<path d="M20 21v-9" />
		<path d="M20 9V3" />
		<path d="M2 10h4" />
		<path d="M10 14h4" />
		<path d="M18 9h4" />
	{:else if name === 'gear'}
		<circle cx="12" cy="12" r="3" />
		<path d="M19.4 15a1.7 1.7 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.08V21a2 2 0 1 1-4 0v-.12a1.7 1.7 0 0 0-.4-1.08 1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.08-.4H2.8a2 2 0 1 1 0-4h.12a1.7 1.7 0 0 0 1.08-.4 1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.08V2.8a2 2 0 1 1 4 0v.12a1.7 1.7 0 0 0 .4 1.08 1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.28.3.48.65.6 1 .08.26.12.53.12.8 0 .27-.04.54-.12.8a1.7 1.7 0 0 0-.6 1c-.08.26-.12.53-.12.8 0 .27.04.54.12.8Z" />
	{:else if name === 'pulse'}
		<path d="M22 12h-4l-2.2 5-4.3-10L8.3 12H2" />
	{:else if name === 'route'}
		<circle cx="6" cy="19" r="2" />
		<path d="M6 17V7a2 2 0 0 1 2-2h10" />
		<path d="m14 3 4 4-4 4" />
		<circle cx="18" cy="7" r="2" />
	{:else if name === 'link'}
		<path d="M10 13a5 5 0 0 0 7.54.54l2.02-2.02a5 5 0 0 0-7.07-7.07l-1.3 1.3" />
		<path d="M14 11a5 5 0 0 0-7.54-.54l-2.02 2.02a5 5 0 0 0 7.07 7.07l1.3-1.3" />
	{/if}
</svg>

<style>
	svg {
		flex: none;
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
</style>
