<script lang="ts">
	import { tick } from 'svelte';
	import '@xterm/xterm/css/xterm.css';
	import Icon from '$lib/components/Icon.svelte';
	import ShellAction from '$lib/components/ShellAction.svelte';
	import ShellSessions from '$lib/components/ShellSessions.svelte';
	import ShellCommandInput from '$lib/components/ShellCommandInput.svelte';
	import { commandHistoryScope } from '$lib/shell/history';
	import { parseShellLaunch, type ShellLaunch } from '$lib/shell/launch';
	import { shellStyles } from '$lib/shell/theme';
	import {
		createShellTerminal,
		type ShellTerminal,
		type ShellSessionState
	} from '$lib/shell/terminal';
	import type { ShellStatus } from '$lib/shell/transport';

	let launch = $state<ShellLaunch | null>(null);
	let origin = $state('');
	let status = $state<ShellStatus>({ phase: 'connecting', message: 'Loading terminal…' });
	let dimensions = $state('');
	let query = $state('');
	let commandDraft = $state('');
	let searchOpen = $state(false);
	let searchMessage = $state('');
	let busy = $state(false);
	let sessionState = $state<ShellSessionState>({
		sessions: [],
		activeId: '',
		backend: 'live',
		demoReason: '',
		error: ''
	});
	let controller = $state.raw<ShellTerminal | null>(null);
	let searchInput: HTMLInputElement;
	let searchReturnFocus: HTMLElement | null = null;
	const title = $derived(launch?.target.kind === 'container' ? launch.target.name : 'VM shell');
	const context = $derived(
		launch?.target.kind === 'container' ? `${launch.target.project} / ${launch.target.service}` : ''
	);
	const activeSession = $derived(
		sessionState.sessions.find((session) => session.id === sessionState.activeId)
	);
	const historyScope = $derived(
		launch && origin ? commandHistoryScope(launch, sessionState.backend, origin) : ''
	);
	const connectionLabel = $derived(
		status.phase === 'connected'
			? 'Connected'
			: status.phase === 'connecting'
				? 'Connecting'
				: status.phase === 'closed'
					? sessionState.activeId
						? 'Session exited'
						: 'No session'
					: 'Disconnected'
	);
	const demoDescription = $derived(
		`No commands run on the container or VM. ${sessionState.demoReason.includes('Browser storage is unavailable') ? 'Sessions last until this tab closes.' : 'Sessions are saved in this browser.'} ${sessionState.demoReason}`
	);

	function mountTerminal(element: HTMLDivElement) {
		let disposed = false;
		let terminal: ShellTerminal | undefined;
		try {
			const config = parseShellLaunch(window.location.hash, window.location.origin);
			origin = window.location.origin;
			launch = config;
			void createShellTerminal(element, config, {
				status: (next) => {
					if (!disposed) status = next;
				},
				dimensions: (cols, rows) => {
					if (!disposed) dimensions = `${cols} × ${rows}`;
				},
				find: () => {
					void openSearch();
				},
				sessions: (next) => {
					if (!disposed) sessionState = next;
				}
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

	async function openSearch() {
		if (!searchOpen)
			searchReturnFocus =
				document.activeElement instanceof HTMLElement ? document.activeElement : null;
		searchOpen = true;
		await tick();
		searchInput?.focus();
		searchInput?.select();
	}
	function closeSearch() {
		searchOpen = false;
		query = '';
		searchMessage = '';
		controller?.search('');
		if (searchReturnFocus?.isConnected) searchReturnFocus.focus();
		else controller?.focus();
	}
	function keyboard(event: KeyboardEvent) {
		if (event.defaultPrevented || event.isComposing) return;
		if ((event.metaKey || event.ctrlKey) && !event.altKey && event.code === 'KeyF') {
			event.preventDefault();
			void openSearch();
		} else if (event.key === 'Escape' && searchOpen) {
			event.preventDefault();
			closeSearch();
		}
	}
	function find(previous = false) {
		searchMessage =
			query && controller ? (controller.search(query, previous) ? '' : 'No matches') : '';
	}
	async function act(action: () => Promise<void>) {
		if (busy) return;
		busy = true;
		try {
			await action();
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>
<svelte:window
	onkeydown={keyboard}
	onpagehide={() => controller?.dispose()}
	onpageshow={(event) => {
		if (event.persisted) window.location.reload();
	}}
/>

<main class="shell-window" style={shellStyles}>
	<header>
		<div class="identity"><h1 title={context || undefined}>{title}</h1></div>
		<ShellSessions
			sessions={sessionState.sessions}
			activeId={sessionState.activeId}
			busy={busy || !controller || status.phase === 'connecting'}
			onrefresh={() => {
				void controller?.refreshSessions();
			}}
			onselect={(id) => {
				void act(() => controller!.attachSession(id));
			}}
			onnew={() => {
				void act(() => controller!.newSession());
			}}
			onclose={(id) => {
				void act(() => controller!.closeSession(id));
			}}
		/>
		<div class="header-actions">
			{#if sessionState.backend === 'demo'}
				<ShellAction
					label="Demo shell"
					description={demoDescription}
					placement="bottom"
					align="center"
					tone="info"
					badge>Demo</ShellAction
				>
				<ShellAction
					label="Retry live backend"
					description="Try connecting to the container or VM."
					placement="bottom"
					disabled={!controller || busy || status.phase === 'connecting'}
					onclick={() => {
						void act(() => controller!.retryLive());
					}}><Icon name="refresh" size={15} stroke={1.7} /></ShellAction
				>
			{/if}
			{#if status.phase === 'error'}
				<ShellAction
					label="Reconnect"
					description="Reattach to this session."
					placement="bottom"
					disabled={!controller || busy}
					onclick={() => {
						void act(() => controller!.reconnect());
					}}><Icon name="refresh" size={15} stroke={1.7} /></ShellAction
				>
			{/if}
			<ShellAction
				label={connectionLabel}
				description={status.message === connectionLabel ? '' : status.message}
				placement="bottom"
				tone={status.phase === 'connected'
					? 'success'
					: status.phase === 'error'
						? 'danger'
						: status.phase === 'connecting'
							? 'warning'
							: 'muted'}><span class="connection-dot" data-phase={status.phase}></span></ShellAction
			>
			<span class="sr-only" role="status">{connectionLabel}</span>
			<ShellAction
				label="Close session"
				description="Terminate this session and delete its socket."
				placement="bottom"
				tone="danger"
				disabled={!controller || !sessionState.activeId || busy || status.phase === 'connecting'}
				onclick={() => {
					void act(() => controller!.closeSession(sessionState.activeId));
				}}><Icon name="close" size={16} stroke={1.7} /></ShellAction
			>
		</div>
	</header>
	{#if sessionState.error}<div class="notice error" role="alert">{sessionState.error}</div>{/if}
	{#if status.phase !== 'connected'}
		<div
			class="notice"
			class:error={status.phase === 'error'}
			role={status.phase === 'error' ? 'alert' : 'status'}
		>
			{#if status.phase === 'connecting'}<Icon name="refresh" size={13} spinning />{/if}
			<span>{status.message}</span>
			{#if status.phase === 'error' && launch && !controller}<button
					type="button"
					onclick={() => window.location.reload()}>Reload</button
				>{/if}
		</div>
	{/if}
	<div class="terminal-stage">
		<div class="terminal" aria-label={`${title} terminal`} {@attach mountTerminal}></div>
		{#if searchOpen}
			<form
				class="find-panel"
				aria-label="Find in terminal"
				onsubmit={(event) => {
					event.preventDefault();
					find();
				}}
			>
				<Icon name="search" size={15} stroke={1.7} />
				<input
					{@attach (node) => {
						searchInput = node;
					}}
					aria-label="Find in terminal output"
					placeholder="Find in output"
					bind:value={query}
					oninput={(event) => {
						query = event.currentTarget.value;
						find();
					}}
					onkeydown={(event) => {
						if (event.key === 'Enter' && event.shiftKey) {
							event.preventDefault();
							find(true);
						}
					}}
				/>
				<span class="search-result" role="status">{searchMessage}</span>
				<button
					type="button"
					aria-label="Previous match"
					title="Previous match (Shift+Enter)"
					disabled={!query || !controller}
					onclick={() => find(true)}>↑</button
				>
				<button
					type="submit"
					aria-label="Next match"
					title="Next match (Enter)"
					disabled={!query || !controller}>↓</button
				>
				<button
					type="button"
					aria-label="Close search"
					title="Close search (Esc)"
					onclick={closeSearch}><Icon name="close" size={14} /></button
				>
			</form>
		{/if}
	</div>
	{#if historyScope}
		{#key historyScope}
			<ShellCommandInput
				bind:draft={commandDraft}
				scope={historyScope}
				cwd={activeSession?.cwd ?? ''}
				sessionId={sessionState.activeId}
				connected={status.phase === 'connected' && !busy}
				onsend={(text) => controller?.sendCommand(text) ?? false}
			/>
		{/key}
	{/if}
	<footer>
		<span class="terminal-metadata"
			>{status.shell ?? 'bash'}<span class="separator">·</span>{dimensions || 'PTY'}</span
		>
		<ShellAction
			label="Shell shortcuts"
			description="Closing this tab detaches; the session keeps running. Use Cmd / Ctrl + F to find in terminal output."
			tone="muted"
		/>
	</footer>
</main>

<style>
	.shell-window {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		min-width: 320px;
		color-scheme: dark;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		background: var(--shell-bg);
		color: var(--shell-text);
	}
	header {
		display: flex;
		flex: none;
		align-items: center;
		gap: 1rem;
		min-height: 56px;
		padding: 0.5rem 1.25rem;
		border-bottom: 1px solid var(--shell-border);
		background: var(--shell-chrome);
	}
	.identity {
		flex: 1;
		min-width: 0;
	}
	h1 {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		font-weight: 550;
		letter-spacing: -0.01em;
	}
	.header-actions {
		display: flex;
		flex: none;
		align-items: center;
		gap: 2px;
	}
	.connection-dot {
		display: block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: currentColor;
	}
	.connection-dot[data-phase='connecting'] {
		background: transparent;
		border: 1px solid currentColor;
	}
	.connection-dot[data-phase='error'] {
		background: var(--shell-danger);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--shell-muted);
		cursor: pointer;
		font-size: 14px;
	}
	button:hover:enabled {
		background: var(--shell-hover);
		color: var(--shell-text);
	}
	button:focus-visible {
		outline: 2px solid var(--shell-accent);
		outline-offset: 2px;
	}
	/* Restore keyboard focus inside this page despite the app-wide focus reset. */
	.shell-window :global(button:focus-visible),
	.shell-window :global(summary:focus-visible) {
		outline: 2px solid var(--shell-accent) !important;
		outline-offset: 2px;
	}
	button:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.terminal-stage {
		position: relative;
		flex: 1;
		min-height: 0;
	}
	.terminal {
		width: 100%;
		height: 100%;
		padding: 1.25rem 1rem 0.5rem 1.25rem;
		overflow: hidden;
	}
	.find-panel {
		position: absolute;
		z-index: 10;
		top: 12px;
		right: 20px;
		display: flex;
		align-items: center;
		gap: 4px;
		width: min(400px, calc(100% - 40px));
		padding: 6px 8px;
		border: 1px solid var(--shell-border);
		border-radius: 8px;
		background: var(--shell-raised);
		box-shadow: 0 6px 24px #0006;
		color: var(--shell-muted);
	}
	input {
		flex: 1;
		min-width: 0;
		width: 0;
		border: 0;
		outline: 0;
		background: transparent;
		padding: 4px;
		color: var(--shell-text);
		font: inherit;
		font-size: 12px;
	}
	input::placeholder {
		color: var(--shell-muted);
	}
	.find-panel:focus-within {
		border-color: var(--shell-accent);
	}
	.search-result {
		flex: none;
		color: var(--shell-warning);
		font-size: 11px;
	}
	.notice {
		display: flex;
		flex: none;
		align-items: center;
		gap: 0.65rem;
		padding: 0.7rem 1.25rem;
		border-bottom: 1px solid var(--shell-border);
		background: var(--shell-chrome);
		color: var(--shell-muted);
		font-size: 12px;
		line-height: 1.5;
	}
	.notice.error {
		color: var(--shell-danger);
	}
	.notice button {
		width: auto;
		padding: 0 0.5rem;
		margin-left: auto;
		font-size: 12px;
	}
	footer {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: space-between;
		padding: 0 0.9rem 0.25rem 1.3rem;
		min-height: 30px;
		color: var(--shell-muted);
	}
	.terminal-metadata {
		font:
			10px/1.5 'SFMono-Regular',
			Consolas,
			'Liberation Mono',
			monospace;
	}
	.separator {
		padding: 0 0.6rem;
		color: #686862;
	}
	@media (max-width: 640px) {
		header {
			gap: 0.5rem;
			flex-wrap: wrap;
			padding: 0.5rem 0.75rem;
		}
		.identity {
			flex-basis: 0;
		}
		.terminal {
			padding: 1rem 0.5rem 0.25rem 0.75rem;
		}
		.find-panel {
			right: 12px;
			width: calc(100% - 24px);
		}
		input {
			font-size: 16px;
		}
		footer {
			padding-left: 0.85rem;
			padding-right: 0.5rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.notice :global(.spinning) {
			animation: none;
		}
	}
</style>
