<script lang="ts">
	import '@xterm/xterm/css/xterm.css';
	import Icon from '$lib/components/Icon.svelte';
	import { parseShellLaunch, type ShellLaunch } from '$lib/shell/launch';
	import { createShellTerminal, type ShellTerminal } from '$lib/shell/terminal';
	import type { ShellStatus } from '$lib/shell/transport';

	let launch = $state<ShellLaunch | null>(null);
	let status = $state<ShellStatus>({ phase: 'connecting', message: 'Loading terminal…' });
	let dimensions = $state('');
	let query = $state('');
	let searchMessage = $state('');
	let screenReader = $state(false);
	let controller = $state.raw<ShellTerminal | null>(null);
	let searchInput: HTMLInputElement;
	const title = $derived(launch?.target.kind === 'container' ? launch.target.name : 'VM Shell');
	const subtitle = $derived(
		launch?.target.kind === 'container'
			? `${launch.target.project} / ${launch.target.service}`
			: 'Virtual machine'
	);

	function mountTerminal(element: HTMLDivElement) {
		let disposed = false;
		let terminal: ShellTerminal | undefined;
		try {
			const config = parseShellLaunch(window.location.hash, window.location.origin);
			launch = config;
			void createShellTerminal(element, config, {
				status: (next) => {
					if (!disposed) status = next;
				},
				dimensions: (cols, rows) => {
					if (!disposed) dimensions = `${cols} × ${rows}`;
				},
				find: () => searchInput?.focus()
			})
				.then((created) => {
					terminal = created;
					if (disposed) created.dispose();
					else controller = created;
				})
				.catch((error) => {
					if (!disposed)
						status = {
							phase: 'error',
							message:
								error instanceof Error
									? error.message
									: 'The terminal could not load. Reload this tab to try again.'
						};
				});
		} catch (error) {
			status = {
				phase: 'error',
				message: error instanceof Error ? error.message : 'This shell link is invalid.'
			};
		}
		return () => {
			disposed = true;
			terminal?.dispose();
		};
	}

	function find(previous = false) {
		searchMessage =
			query && controller ? (controller.search(query, previous) ? '' : 'No matches') : '';
	}

	function disconnectOnLeave() {
		controller?.dispose();
	}
</script>

<svelte:head>
	<title>{title} — Shell</title>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>
<svelte:window
	onpagehide={disconnectOnLeave}
	onpageshow={(event) => {
		if (event.persisted) window.location.reload();
	}}
/>

<main class="shell-window">
	<header>
		<div class="identity">
			<span class="terminal-mark"><Icon name="terminal" size={20} /></span>
			<div class="identity-copy">
				<h1>{title}</h1>
				<p>{subtitle}</p>
			</div>
		</div>
		<div class="connection" data-phase={status.phase} role="status">
			<span class="connection-dot"></span>
			{status.phase === 'connected'
				? 'Connected'
				: status.phase === 'connecting'
					? 'Connecting'
					: status.phase === 'closed'
						? 'Exited'
						: 'Disconnected'}
		</div>
		<button
			type="button"
			class="reconnect"
			disabled={!controller || status.phase === 'connecting'}
			onclick={() => controller?.reconnect()}
			title="Close the current shell and open a new session"
			><Icon name="refresh" size={13} />New session</button
		>
	</header>

	<div class="toolbar">
		<form
			class="find"
			onsubmit={(event) => {
				event.preventDefault();
				find();
			}}
		>
			<Icon name="search" size={13} />
			<input
				{@attach (node) => {
					searchInput = node;
				}}
				aria-label="Find in terminal output"
				placeholder="Find in output"
				bind:value={query}
				oninput={() => {
					searchMessage = '';
					if (!query) controller?.search('');
				}}
				onkeydown={(event) => {
					if (event.key === 'Escape') controller?.focus();
				}}
			/>
			<button
				type="button"
				aria-label="Previous match"
				disabled={!query || !controller}
				onclick={() => find(true)}>↑</button
			>
			<button type="submit" aria-label="Next match" disabled={!query || !controller}>↓</button>
			<span class="search-result" role="status">{searchMessage}</span>
		</form>
		<div class="display-controls">
			<button
				type="button"
				aria-label="Decrease terminal font size"
				disabled={!controller}
				onclick={() => controller?.zoom(-1)}>A−</button
			>
			<button
				type="button"
				aria-label="Increase terminal font size"
				disabled={!controller}
				onclick={() => controller?.zoom(1)}>A+</button
			>
			<button
				type="button"
				class:active={screenReader}
				aria-pressed={screenReader}
				disabled={!controller}
				onclick={() => {
					screenReader = !screenReader;
					controller?.screenReader(screenReader);
				}}>Screen reader</button
			>
		</div>
	</div>

	{#if status.phase !== 'connected' || status.shell === 'sh'}
		<div
			class="notice"
			class:error={status.phase === 'error'}
			role={status.phase === 'error' ? 'alert' : 'status'}
		>
			{#if status.phase === 'connecting'}<Icon name="refresh" size={13} spinning />{/if}
			<span>{status.message}</span>
			{#if status.phase === 'error' && launch && !controller}
				<button type="button" onclick={() => window.location.reload()}>Reload</button>
			{/if}
		</div>
	{/if}

	<div class="terminal" aria-label={`${title} terminal`} {@attach mountTerminal}></div>
	<footer>
		<span>{status.shell ?? 'bash'}<span class="footer-separator">/</span>{dimensions || 'PTY'}</span
		>
		<span class="keyboard-help"
			>Ctrl / ⌘ + Shift + F to find<span class="footer-separator">·</span>Ctrl / ⌘ + click to open
			links</span
		>
	</footer>
</main>

<style>
	.shell-window {
		--shell-bg: #070b10;
		--shell-chrome: #0d131b;
		--shell-border: #23303d;
		--shell-muted: #94a3b3;
		--shell-text: #dfe5eb;
		--shell-accent: #7fc4ea;
		display: flex;
		flex-direction: column;
		height: 100dvh;
		min-width: 320px;
		background: var(--shell-bg);
		color: var(--shell-text);
	}
	header {
		display: flex;
		flex: none;
		align-items: center;
		gap: 1rem;
		padding: 0.85rem 1rem;
		border-bottom: 1px solid var(--shell-border);
		background: var(--shell-chrome);
	}
	.identity {
		display: flex;
		flex: 1;
		min-width: 0;
		align-items: center;
		gap: 0.7rem;
	}
	.terminal-mark {
		display: grid;
		flex: none;
		width: 2.15rem;
		height: 2.15rem;
		place-items: center;
		color: var(--shell-accent);
	}
	.identity-copy {
		min-width: 0;
	}
	h1,
	p {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	h1 {
		font-size: 0.9rem;
		font-weight: 600;
	}
	p {
		margin-top: 0.1rem;
		color: var(--shell-muted);
		font-size: 0.7rem;
	}
	.connection {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 0.4rem;
		color: var(--shell-muted);
		font-size: 0.72rem;
	}
	.connection-dot {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 50%;
		background: #e1bc79;
	}
	.connection[data-phase='connected'] .connection-dot {
		background: #8acb91;
	}
	.connection[data-phase='error'] .connection-dot {
		background: #e07b7b;
	}
	.connection[data-phase='closed'] .connection-dot {
		background: var(--shell-muted);
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		min-height: 1.9rem;
		padding: 0.3rem 0.5rem;
		border: 1px solid transparent;
		border-radius: 0.35rem;
		background: transparent;
		color: var(--shell-muted);
		font-size: 0.72rem;
		cursor: pointer;
		white-space: nowrap;
	}
	button:hover:enabled,
	button.active {
		background: #182633;
		color: var(--shell-text);
	}
	button:focus-visible,
	input:focus-visible {
		border-color: var(--shell-accent);
	}
	button:disabled {
		cursor: default;
		opacity: 0.4;
	}
	.reconnect {
		border-color: var(--shell-border);
	}
	.toolbar {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.35rem 0.75rem;
		border-bottom: 1px solid var(--shell-border);
	}
	.find {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 0.25rem;
		color: var(--shell-muted);
	}
	input {
		width: 11rem;
		min-width: 0;
		padding: 0.3rem 0.5rem;
		border: 1px solid transparent;
		border-radius: 0.3rem;
		background: transparent;
		color: var(--shell-text);
		font-size: 0.72rem;
	}
	input::placeholder {
		color: var(--shell-muted);
	}
	.search-result {
		color: #e1bc79;
		font-size: 0.7rem;
	}
	.display-controls {
		display: flex;
		flex: none;
		align-items: center;
		gap: 0.25rem;
	}
	.notice {
		display: flex;
		flex: none;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem 1rem;
		border-bottom: 1px solid var(--shell-border);
		background: #111b26;
		color: #b6cadd;
		font-size: 0.78rem;
	}
	.notice.error {
		background: #23171b;
		color: #f09b9b;
	}
	.terminal {
		flex: 1;
		min-height: 0;
		padding: 0.8rem 0.6rem 0.3rem 1rem;
		overflow: hidden;
	}
	footer {
		display: flex;
		flex: none;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.5rem 1rem;
		border-top: 1px solid var(--shell-border);
		color: var(--shell-muted);
		font-family: 'SFMono-Regular', Consolas, monospace;
		font-size: 0.65rem;
	}
	.footer-separator {
		padding: 0 0.6rem;
		color: #536576;
	}
	@media (max-width: 640px) {
		header {
			gap: 0.5rem;
			padding: 0.6rem;
			flex-wrap: wrap;
		}
		.identity {
			flex-basis: calc(100% - 7rem);
		}
		.toolbar {
			flex-wrap: wrap;
		}
		.find {
			width: 100%;
		}
		input {
			flex: 1;
		}
		.keyboard-help {
			display: none;
		}
		.terminal {
			padding-left: 0.5rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.notice :global(.spinning) {
			animation: none;
		}
	}
</style>
