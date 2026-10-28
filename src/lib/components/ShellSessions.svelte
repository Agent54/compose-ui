<script lang="ts">
	import Icon from './Icon.svelte';
	import ShellAction from './ShellAction.svelte';
	import type { ShellSession } from '$lib/shell/session';
	let {
		sessions,
		activeId,
		busy,
		onselect,
		onnew,
		onclose,
		onrefresh
	}: {
		sessions: ShellSession[];
		activeId: string;
		busy: boolean;
		onselect: (id: string) => void;
		onnew: () => void;
		onclose: (id: string) => void;
		onrefresh: () => void;
	} = $props();
	const active = $derived(sessions.find((session) => session.id === activeId));
	function dismiss(element: HTMLDetailsElement) {
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Node && !element.contains(event.target)) element.open = false;
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && element.open) {
				element.open = false;
				element.querySelector('summary')?.focus();
			}
		};
		window.addEventListener('pointerdown', outside);
		window.addEventListener('keydown', escape);
		return () => {
			window.removeEventListener('pointerdown', outside);
			window.removeEventListener('keydown', escape);
		};
	}
	function choose(event: MouseEvent, action: () => void) {
		(event.currentTarget as HTMLButtonElement).closest('details')!.open = false;
		action();
	}
</script>

<details
	class="sessions"
	{@attach dismiss}
	ontoggle={(event) => {
		if (event.currentTarget.open) onrefresh();
	}}
>
	<summary aria-label="Shell sessions">
		<span class="session-current">
			<strong
				>{active
					? active.name === `Session ${active.number}`
						? active.name
						: `#${active.number} ${active.name}`
					: 'Select a session'}</strong
			>
			<span class="metadata"
				>{active ? active.command || 'Exited' : `${sessions.length} available`}</span
			>
		</span>
		<Icon name="chevron" size={13} rotated />
	</summary>
	<div class="dropdown">
		<div class="dropdown-heading">
			<span>Sessions <span class="session-count">{sessions.length}</span></span>
			<ShellAction
				label="About sessions"
				description="Closing a tab only detaches. Close session terminates the shell and deletes its socket."
				placement="bottom"
			/>
		</div>
		<ul aria-label="Available shell sessions">
			{#each sessions as session (session.id)}
				<li class:current={session.id === activeId}>
					<button
						type="button"
						class="select-session"
						disabled={busy || session.state === 'exited'}
						aria-current={session.id === activeId ? 'true' : undefined}
						onclick={(event) => choose(event, () => onselect(session.id))}
					>
						<span class="session-heading"
							><strong
								>{session.name === `Session ${session.number}`
									? session.name
									: `#${session.number} ${session.name}`}</strong
							>
							<span class="session-state"
								>{session.state === 'exited'
									? 'Exited'
									: session.id === activeId
										? 'Attached'
										: ''}</span
							></span
						>
						<span class="metadata command" title={session.command}
							>{session.command || 'Shell exited'}</span
						>
						<span class="metadata cwd" title={session.cwd}>{session.cwd}</span>
					</button>
					<button
						type="button"
						class="close-session"
						disabled={busy}
						aria-label={`Close session ${session.name}`}
						title={`Terminate and delete ${session.name}`}
						onclick={() => onclose(session.id)}><Icon name="close" size={14} stroke={1.7} /></button
					>
				</li>
			{:else}<li class="empty">No sessions yet</li>{/each}
		</ul>
		<button
			type="button"
			class="new-session"
			disabled={busy}
			onclick={(event) => choose(event, onnew)}><span>+</span>New session</button
		>
	</div>
</details>

<style>
	.sessions {
		position: relative;
		min-width: 0;
		width: min(16rem, 36vw);
	}
	summary {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 30px;
		padding: 0.25rem 0.5rem;
		border: 1px solid transparent;
		border-radius: 6px;
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary:hover,
	.sessions[open] summary {
		border-color: var(--shell-border);
		background: var(--shell-hover);
	}
	.session-current {
		display: flex;
		align-items: center;
		flex: 1;
		min-width: 0;
		gap: 0.5rem;
	}
	strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		font-weight: 500;
	}
	.metadata {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: 'SFMono-Regular', Consolas, monospace;
		font-size: 11px;
		color: var(--shell-muted);
	}
	.dropdown {
		position: absolute;
		z-index: 5;
		top: calc(100% + 0.5rem);
		right: 0;
		width: min(22rem, calc(100vw - 1.5rem));
		padding: 6px;
		border: 1px solid var(--shell-border);
		border-radius: 7px;
		background: var(--shell-raised);
		box-shadow: 0 12px 32px #0006;
	}
	.dropdown-heading {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0 6px 6px;
		color: var(--shell-muted);
		font-size: 11px;
	}
	.session-count {
		margin-left: 6px;
		color: var(--shell-text);
	}
	ul {
		margin: 0;
		padding: 3px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		list-style: none;
		max-height: min(22rem, 50dvh);
		overflow-y: auto;
	}
	li {
		display: flex;
		align-items: center;
		border-radius: 6px;
		flex: none;
	}
	li:hover,
	li:focus-within {
		background: var(--shell-hover);
	}
	li.current {
		background: var(--shell-active);
		box-shadow: inset 0 0 0 1px var(--shell-border);
	}
	button {
		color: var(--shell-text);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 0.35rem;
		cursor: pointer;
		font: inherit;
	}
	button:disabled {
		cursor: default;
		opacity: 0.5;
	}
	button:focus-visible,
	summary:focus-visible {
		outline: 2px solid var(--shell-accent);
		outline-offset: -2px;
	}
	.select-session {
		display: grid;
		gap: 4px;
		min-width: 0;
		flex: 1;
		text-align: left;
		padding: 10px;
	}
	.session-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		min-width: 0;
	}
	.session-state {
		color: var(--shell-muted);
		font-size: 10px;
	}
	.command {
		color: var(--shell-text);
	}
	.close-session {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 1.75rem;
		height: 1.75rem;
		margin: 0.4rem;
		opacity: 0;
		font-size: 1.1rem;
		color: var(--shell-muted);
	}
	li:hover .close-session,
	li:focus-within .close-session {
		opacity: 1;
	}
	.close-session:hover:enabled {
		background: color-mix(in srgb, var(--shell-danger) 12%, transparent);
		color: var(--shell-danger);
	}
	.new-session {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		margin-top: 8px;
		padding: 9px 12px;
		text-align: left;
		color: var(--shell-accent);
		font-size: 12px;
	}
	.new-session:hover:enabled {
		background: var(--shell-hover);
	}
	.new-session span {
		font-size: 1.1rem;
	}
	.empty {
		margin: 0;
		padding: 0.6rem;
		font-size: 0.65rem;
		color: var(--shell-muted);
		line-height: 1.5;
	}
	@media (hover: none) {
		.close-session {
			opacity: 1;
		}
	}
	@media (max-width: 640px) {
		.sessions {
			width: 100%;
			order: 3;
		}
		.dropdown {
			width: 100%;
		}
	}
</style>
