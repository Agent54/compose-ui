<script lang="ts">
	import Icon from './Icon.svelte';
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
			<strong>{active ? `#${active.number} ${active.name}` : 'Select a session'}</strong>
			<span class="metadata"
				>{active
					? `${active.command || 'Exited'} · ${active.cwd}`
					: `${sessions.length} available`}</span
			>
		</span>
		<Icon name="chevron" size={13} rotated />
	</summary>
	<div class="dropdown">
		<div class="dropdown-heading">
			<span>Persistent sessions</span><span>{sessions.length}</span>
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
							><strong>#{session.number} {session.name}</strong>
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
						onclick={() => onclose(session.id)}>×</button
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
		<p>Closing this tab only detaches. Close session deletes it.</p>
	</div>
</details>

<style>
	.sessions {
		position: relative;
		min-width: 0;
		width: min(26rem, 35vw);
	}
	summary {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.4rem 0.65rem;
		border: 1px solid var(--shell-border);
		border-radius: 0.4rem;
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary:hover,
	.sessions[open] summary {
		border-color: #536576;
		background: #131e29;
	}
	.session-current {
		display: grid;
		flex: 1;
		min-width: 0;
		gap: 0.2rem;
	}
	strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.75rem;
		font-weight: 600;
	}
	.metadata {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: 'SFMono-Regular', Consolas, monospace;
		font-size: 0.65rem;
		color: var(--shell-muted);
	}
	.dropdown {
		position: absolute;
		z-index: 5;
		top: calc(100% + 0.5rem);
		right: 0;
		width: min(30rem, calc(100vw - 1.2rem));
		padding: 0.35rem;
		border: 1px solid #34485b;
		border-radius: 0.6rem;
		background: #0d151f;
		box-shadow: 0 12px 40px #0008;
	}
	.dropdown-heading {
		display: flex;
		justify-content: space-between;
		padding: 0.6rem;
		color: var(--shell-muted);
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
		max-height: min(22rem, 50dvh);
		overflow-y: auto;
	}
	li {
		display: flex;
		align-items: center;
		border-radius: 0.35rem;
	}
	li:hover,
	li:focus-within {
		background: #172635;
	}
	li.current {
		background: #152332;
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
		outline-offset: 1px;
	}
	.select-session {
		display: grid;
		gap: 0.25rem;
		min-width: 0;
		flex: 1;
		text-align: left;
		padding: 0.65rem;
	}
	.session-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		min-width: 0;
	}
	.session-state {
		color: var(--shell-accent);
		font-size: 0.6rem;
	}
	.command {
		color: #c2d4e5;
	}
	.close-session {
		flex: none;
		width: 2rem;
		height: 2rem;
		margin: 0.4rem;
		opacity: 0;
		font-size: 1.1rem;
		color: #f09b9b;
	}
	li:hover .close-session,
	li:focus-within .close-session {
		opacity: 1;
	}
	.close-session:hover:enabled {
		background: #38242a;
	}
	.new-session {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		margin-top: 0.3rem;
		padding: 0.65rem;
		border-top-color: var(--shell-border);
		text-align: left;
		color: var(--shell-accent);
		font-size: 0.75rem;
	}
	.new-session:hover:enabled {
		background: #172635;
	}
	.new-session span {
		font-size: 1.1rem;
	}
	p,
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
