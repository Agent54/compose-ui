<script lang="ts">
	import { tick } from 'svelte';
	import Icon from './Icon.svelte';
	import ShellAction from './ShellAction.svelte';
	import { canBrowseHistory, highlightShell } from '$lib/shell/command';
	import { CommandHistory, type CommandEntry } from '$lib/shell/history';
	import { CommandPins, type PinnedCommand } from '$lib/shell/pins';

	let {
		draft = $bindable(''),
		scope,
		cwd,
		sessionId,
		connected,
		onsend
	}: {
		draft?: string;
		scope: string;
		cwd: string;
		sessionId: string;
		connected: boolean;
		onsend: (text: string) => boolean;
	} = $props();
	const uid = $props.id();
	let message = $state('');
	let historyError = $state('');
	let pinError = $state('');
	let pins = $state.raw<PinnedCommand[]>([]);
	let entries = $state.raw<CommandEntry[]>([]);
	let historyOpen = $state(false);
	let loading = $state(false);
	let more = $state(false);
	let composing = $state(false);
	let scrollLeft = $state(0);
	let scrollTop = $state(0);
	let history: CommandHistory | undefined;
	let pinStore: CommandPins | undefined;
	let textarea: HTMLTextAreaElement;
	let menu: HTMLDetailsElement;
	let selectedEntry = $state.raw<CommandEntry | null>(null);
	let selectedPin = $state<string | null>(null);
	let historyPresses = 0;
	let pendingDirections: Array<'older' | 'newer'> = [];
	let pageCursor: number | undefined;
	let savedDraft = '';
	let navigation = 0;
	let navigating = false;
	let disposed = false;
	const tokens = $derived(highlightShell(draft + '\n'));
	const rows = $derived(Math.min(6, draft.split('\n').length));
	const pinnedTexts = $derived(new Set(pins.map((pin) => pin.text)));
	const selectedKey = $derived(
		selectedEntry
			? `history:${selectedEntry.id}`
			: selectedPin
				? pinnedTexts.has(selectedPin)
					? `pin:${selectedPin}`
					: `history:${entries.find((entry) => entry.text === selectedPin)?.id}`
				: ''
	);
	const inputHelp =
		'Enter to send. Shift + Enter for a new line. Use ↑ and ↓ to browse history; repeated presses open the menu. Pin commands to keep them at the top. History and pins are saved in this browser.';

	function closeHistory() {
		historyOpen = false;
		historyPresses = 0;
		++navigation;
		pendingDirections = [];
		navigating = false;
	}

	function readPins() {
		try {
			if (pinStore) pins = pinStore.list();
			pinError = '';
		} catch {
			pinError = 'Pinned commands could not be read from this browser.';
		}
	}

	function mountHistory(node: HTMLDetailsElement) {
		menu = node;
		try {
			history = new CommandHistory(scope);
		} catch {
			historyError = 'Browser storage is unavailable; command history cannot be saved.';
		}
		try {
			pinStore = new CommandPins(scope, window.localStorage);
			readPins();
		} catch {
			pinError = 'Browser storage is unavailable; commands cannot be pinned.';
		}
		const outside = (event: PointerEvent) => {
			if (!node.contains(event.target as Node)) closeHistory();
		};
		const panelKeyboard = (event: KeyboardEvent) => {
			if (!historyOpen || event.defaultPrevented || event.isComposing) return;
			if (
				event.key === 'Escape' &&
				(node.contains(document.activeElement) || document.activeElement === textarea)
			) {
				event.preventDefault();
				closeHistory();
				textarea.focus();
			} else if (
				node.contains(document.activeElement) &&
				['ArrowUp', 'ArrowDown'].includes(event.key) &&
				!event.shiftKey &&
				!event.altKey &&
				!event.ctrlKey &&
				!event.metaKey
			) {
				event.preventDefault();
				void browse(!selectedEntry || event.key === 'ArrowUp' ? 'older' : 'newer');
			}
		};
		const storageChanged = (event: StorageEvent) => {
			if (event.key === null || event.key === pinStore?.key) readPins();
		};
		document.addEventListener('pointerdown', outside);
		document.addEventListener('keydown', panelKeyboard);
		window.addEventListener('storage', storageChanged);
		return () => {
			disposed = true;
			++navigation;
			history?.close();
			document.removeEventListener('pointerdown', outside);
			document.removeEventListener('keydown', panelKeyboard);
			window.removeEventListener('storage', storageChanged);
		};
	}

	async function loadHistory(older = false) {
		if (!history || loading) return;
		loading = true;
		try {
			const page = await history.page(older ? pageCursor : undefined);
			if (disposed) return;
			pageCursor = page.at(-1)?.id;
			const merged: Record<number, CommandEntry> = Object.fromEntries(
				(older ? entries : []).map((entry) => [entry.id, entry])
			);
			for (const entry of page) merged[entry.id] = entry;
			if (selectedEntry) merged[selectedEntry.id] = selectedEntry;
			entries = Object.values(merged).sort((a, b) => b.id - a.id);
			more = page.length === 40;
			historyError = '';
		} catch {
			if (!disposed) historyError = 'Command history could not be read from this browser.';
		} finally {
			if (!disposed) loading = false;
		}
	}

	function edited() {
		++navigation;
		navigating = false;
		pendingDirections = [];
		historyPresses = 0;
		selectedEntry = null;
		selectedPin = null;
		message = '';
	}

	async function replaceDraft(text: string) {
		draft = text;
		await tick();
		if (disposed) return;
		textarea.focus();
		textarea.setSelectionRange(text.length, text.length);
	}

	async function browse(direction: 'older' | 'newer') {
		if (!history) return;
		if (++historyPresses >= 2) historyOpen = true;
		pendingDirections.push(direction);
		if (navigating) return;
		const revision = navigation;
		navigating = true;
		try {
			while (pendingDirections.length && !disposed && revision === navigation) {
				const next = pendingDirections.shift()!;
				if (next === 'newer' && !selectedEntry) continue;
				if (!selectedEntry) savedDraft = draft;
				const entry = await history.neighbor(selectedEntry?.id, next);
				if (disposed || revision !== navigation) return;
				if (entry) {
					selectedEntry = entry;
					selectedPin = null;
					if (!entries.some((item) => item.id === entry.id))
						entries = [...entries, entry].sort((a, b) => b.id - a.id);
					await replaceDraft(entry.text);
				} else if (next === 'newer') {
					selectedEntry = null;
					await replaceDraft(savedDraft);
				}
			}
		} catch {
			if (!disposed) historyError = 'Command history could not be read from this browser.';
		} finally {
			if (revision === navigation) navigating = false;
		}
	}

	function chooseCommand(entry: CommandEntry | PinnedCommand) {
		if (!selectedEntry) savedDraft = draft;
		closeHistory();
		edited();
		if ('id' in entry) selectedEntry = entry;
		else selectedPin = entry.text;
		void replaceDraft(entry.text);
	}

	async function togglePin(entry: CommandEntry | PinnedCommand, source: HTMLButtonElement) {
		++navigation;
		pendingDirections = [];
		navigating = false;
		try {
			if (!pinStore) throw new Error('Storage unavailable');
			pins = pinStore.toggle(entry);
			pinError = '';
			await tick();
			if (disposed) return;
			const button = source.isConnected
				? source
				: [...menu.querySelectorAll<HTMLButtonElement>('[data-pin-command]')].find(
						(node) => node.dataset.pinCommand === entry.text
					);
			(button ?? menu.querySelector('summary'))?.focus();
		} catch {
			pinError = 'The pin could not be saved. Browser storage may be unavailable or full.';
		}
	}

	function rowKey(entry: CommandEntry | PinnedCommand) {
		return 'id' in entry ? `history:${entry.id}` : `pin:${entry.text}`;
	}

	function submit() {
		if (composing || !draft.trim()) return;
		const text = draft;
		if (!connected || !onsend(text)) {
			message = 'Connect to a session to send this command. Your draft is kept here.';
			return;
		}
		const record = { text, cwd, sessionId };
		historyOpen = false;
		draft = '';
		edited();
		savedDraft = '';
		textarea.focus();
		if (history)
			void history.append(record).then(
				() => {
					if (!disposed) historyError = '';
				},
				() => {
					if (!disposed)
						historyError =
							'Command sent, but history could not be saved. Browser storage may be full.';
				}
			);
	}

	function keydown(event: KeyboardEvent) {
		if (event.isComposing || composing || event.keyCode === 229) return;
		if (
			event.key === 'Enter' &&
			!event.shiftKey &&
			!event.altKey &&
			!event.ctrlKey &&
			!event.metaKey
		) {
			event.preventDefault();
			submit();
		} else if (
			(event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
			!event.shiftKey &&
			!event.altKey &&
			!event.ctrlKey &&
			!event.metaKey
		) {
			const direction = event.key === 'ArrowUp' ? 'older' : 'newer';
			if (canBrowseHistory(draft, textarea.selectionStart, textarea.selectionEnd, direction)) {
				event.preventDefault();
				void browse(direction);
			}
		} else if (event.key === 'Escape' && historyOpen) {
			event.preventDefault();
			closeHistory();
		}
	}
</script>

{#snippet commandRow(entry: CommandEntry | PinnedCommand)}
	{@const pinned = pinnedTexts.has(entry.text)}
	<li
		class="command-row"
		class:current={selectedKey === rowKey(entry)}
		{@attach (node) => {
			if (historyOpen && selectedKey === rowKey(entry)) node.scrollIntoView({ block: 'nearest' });
		}}
	>
		<button
			type="button"
			class="load-command"
			aria-label={`Load command: ${entry.text}`}
			aria-current={selectedKey === rowKey(entry) ? 'true' : undefined}
			title="Load command into editor"
			onclick={() => chooseCommand(entry)}
		>
			<code>{entry.text}</code>
			<span
				>{entry.cwd || 'Unknown directory'}<time datetime={new Date(entry.createdAt).toISOString()}
					>{new Date(entry.createdAt).toLocaleString()}</time
				></span
			>
		</button>
		<button
			type="button"
			class="pin-command"
			aria-label={`${pinned ? 'Unpin' : 'Pin'} command: ${entry.text}`}
			aria-pressed={pinned}
			data-pin-command={entry.text}
			title={pinned ? 'Unpin command' : 'Pin command'}
			onclick={(event) => {
				void togglePin(entry, event.currentTarget);
			}}><Icon name="pin" size={14} stroke={1.7} /></button
		>
	</li>
{/snippet}

<section class="command-editor" aria-label="Command editor">
	<div class="command-topline">
		<label class="sr-only" for={`${uid}-command`}>Command</label>
		<span class="cwd" title={cwd}>{cwd || 'No active session'}</span>
		<details
			class="history"
			bind:open={historyOpen}
			{@attach mountHistory}
			ontoggle={(event) => {
				if (event.currentTarget.open) {
					readPins();
					void loadHistory();
				} else closeHistory();
			}}
		>
			<summary aria-label="Command history"
				><Icon name="history" size={14} stroke={1.7} /> History</summary
			>
			<div class="history-panel" id={`${uid}-history`}>
				<div class="history-heading">
					<strong>Command history</strong>
				</div>
				{#if pins.length}
					<span class="section-heading">Pinned</span>
					<ul class="pins" aria-label="Pinned commands">
						{#each pins as pin (pin.text)}{@render commandRow(pin)}{/each}
					</ul>
					{#if entries.length}<span class="section-heading">Recent</span>{/if}
				{/if}
				<ul class="recent" aria-label="Saved commands">
					{#each entries as entry (entry.id)}
						{@render commandRow(entry)}
					{:else}<li class="empty">
							{loading ? 'Loading history…' : 'Commands sent from this editor appear here.'}
						</li>{/each}
				</ul>
				{#if more}<button
						class="load-older"
						type="button"
						disabled={loading}
						onclick={() => {
							void loadHistory(true);
						}}>{loading ? 'Loading…' : 'Load older commands'}</button
					>{/if}
			</div>
		</details>
		<ShellAction label="Command editor shortcuts" description={inputHelp} />
	</div>
	<form
		onsubmit={(event) => {
			event.preventDefault();
			submit();
		}}
	>
		<span class="prompt" aria-hidden="true">›</span>
		<div class="editor-field">
			<div class="highlight-viewport" aria-hidden="true">
				<pre
					style:transform={`translate(${-scrollLeft}px, ${-scrollTop}px)`}>{#each tokens as token (token.start)}<span
							data-token={token.kind}>{token.text}</span
						>{/each}</pre>
			</div>
			<textarea
				id={`${uid}-command`}
				aria-label="Shell command"
				aria-describedby={`${uid}-help`}
				aria-controls={historyOpen ? `${uid}-history` : undefined}
				{@attach (node) => {
					textarea = node;
					node.setAttribute('autocorrect', 'off');
				}}
				bind:value={draft}
				{rows}
				wrap="off"
				spellcheck={false}
				autocapitalize="off"
				autocomplete="off"
				placeholder="Type a shell command…"
				oninput={edited}
				onkeydown={keydown}
				oncompositionstart={() => {
					composing = true;
				}}
				oncompositionend={() => {
					composing = false;
				}}
				onscroll={() => {
					scrollLeft = textarea.scrollLeft;
					scrollTop = textarea.scrollTop;
				}}
			></textarea>
		</div>
		<ShellAction
			label="Run"
			type="submit"
			tone="accent"
			disabled={!connected || !draft.trim() || composing}
			><Icon name="play" size={14} stroke={1.7} /></ShellAction
		>
	</form>
	<span class="sr-only" id={`${uid}-help`}>{inputHelp}</span>
	{#if message || pinError || historyError}<p class="editor-message" role="status">
			{message || pinError || historyError}
		</p>{/if}
</section>

<style>
	.command-editor {
		position: relative;
		flex: none;
		margin: 0.5rem 1.25rem 0;
		border: 1px solid var(--shell-border);
		border-radius: 8px;
		background: var(--shell-chrome);
	}
	.command-editor:focus-within {
		border-color: var(--shell-focus);
	}
	.command-topline {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 4px 8px 0 14px;
		font-size: 11px;
		color: var(--shell-muted);
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
	.cwd {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
	}
	form {
		display: flex;
		align-items: flex-start;
		gap: 0.7rem;
		padding: 2px 12px 12px 14px;
	}
	.prompt {
		color: var(--shell-accent);
	}
	.editor-field {
		position: relative;
		flex: 1;
		min-width: 0;
		overflow: hidden;
	}
	.prompt,
	textarea,
	pre {
		box-sizing: border-box;
		margin: 0;
		padding: 0.2rem 0;
		border: 0;
		border-radius: 0;
		font:
			14px/1.6 'SFMono-Regular',
			Consolas,
			'Liberation Mono',
			monospace;
		font-variant-ligatures: none;
		letter-spacing: normal;
		tab-size: 4;
		white-space: pre;
	}
	textarea {
		display: block;
		position: relative;
		width: 100%;
		resize: none;
		outline: none;
		color: transparent;
		caret-color: var(--shell-accent);
		background: transparent;
		overflow: auto;
	}
	textarea::selection {
		background: var(--shell-selection);
		color: #fff;
	}
	textarea::placeholder {
		color: var(--shell-muted);
		opacity: 1;
	}
	.highlight-viewport {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: hidden;
	}
	pre {
		width: max-content;
		min-width: 100%;
		color: var(--shell-text);
	}
	[data-token='command'] {
		color: var(--shell-accent);
	}
	[data-token='keyword'],
	[data-token='variable'] {
		color: var(--shell-info);
	}
	[data-token='string'] {
		color: var(--shell-warning);
	}
	[data-token='operator'] {
		color: var(--shell-success);
	}
	[data-token='option'] {
		color: var(--shell-text);
	}
	[data-token='comment'] {
		color: var(--shell-muted);
	}
	button,
	summary {
		cursor: pointer;
	}
	button:disabled {
		cursor: default;
		opacity: 0.45;
	}
	button:focus-visible,
	summary:focus-visible {
		outline: 2px solid var(--shell-accent);
		outline-offset: 3px;
	}
	.editor-message {
		margin: 0;
		padding: 0 0.85rem 0.65rem;
		font-size: 0.7rem;
		color: var(--shell-warning);
	}
	.history {
		flex: none;
	}
	summary {
		display: flex;
		align-items: center;
		gap: 6px;
		list-style: none;
		color: var(--shell-muted);
		padding: 6px;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary:hover,
	.history[open] summary {
		color: var(--shell-accent);
	}
	.history-panel {
		position: absolute;
		z-index: 5;
		bottom: calc(100% + 0.5rem);
		right: 0;
		width: min(36rem, calc(100vw - 1.5rem));
		padding: 8px;
		display: flex;
		flex-direction: column;
		max-height: min(34rem, calc(100dvh - 18rem));
		border: 1px solid var(--shell-border);
		border-radius: 0.6rem;
		background: var(--shell-raised);
		box-shadow: 0 12px 40px #0008;
	}
	.history-heading {
		flex: none;
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.3rem 0.35rem 0.7rem;
	}
	.history-heading strong {
		color: var(--shell-text);
	}
	.section-heading {
		flex: none;
		padding: 7px 9px 5px;
		font-size: 11px;
		font-weight: 500;
		color: var(--shell-muted);
	}
	ul {
		margin: 0;
		padding: 3px;
		display: flex;
		flex-direction: column;
		gap: 5px;
		list-style: none;
		min-height: 0;
		overflow: auto;
	}
	ul.pins {
		flex: 0 0 auto;
		max-height: min(10rem, 22dvh);
	}
	ul.recent {
		flex: 1 1 auto;
		max-height: min(22rem, 36dvh);
	}
	.command-row {
		display: flex;
		flex: none;
		align-items: center;
		gap: 4px;
		border-radius: 6px;
	}
	.command-row:hover,
	.command-row:focus-within {
		background: var(--shell-hover);
	}
	.command-row.current {
		background: var(--shell-active);
		box-shadow: inset 0 0 0 1px #d0f58224;
	}
	.load-command {
		display: block;
		flex: 1;
		min-width: 0;
		padding: 0.65rem 0.5rem;
		text-align: left;
		border: 0;
		border-radius: 0.3rem;
		background: transparent;
		color: var(--shell-text);
	}
	.pin-command {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 28px;
		height: 28px;
		margin-right: 6px;
		padding: 0;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--shell-muted);
		opacity: 0;
	}
	.command-row:hover .pin-command,
	.command-row:focus-within .pin-command,
	.pin-command[aria-pressed='true'] {
		opacity: 1;
	}
	.pin-command[aria-pressed='true'],
	.pin-command:hover {
		color: var(--shell-accent);
	}
	.pin-command:hover {
		background: #d0f58215;
	}
	code {
		display: block;
		font-size: 12px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.load-command > span {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: 0.35rem;
		font-size: 11px;
		color: var(--shell-muted);
		overflow-wrap: anywhere;
	}
	time {
		flex: none;
	}
	.empty {
		padding: 1.2rem 0.5rem;
		font-size: 0.75rem;
	}
	.load-older {
		flex: none;
		width: 100%;
		margin-top: 0.5rem;
		padding: 0.5rem;
		border: 1px solid var(--shell-border);
		border-radius: 0.3rem;
		background: var(--shell-hover);
		color: var(--shell-accent);
	}
	@media (max-width: 640px) {
		.command-editor {
			margin: 0.4rem 0.75rem 0;
		}
		.prompt,
		textarea,
		pre {
			font-size: 16px;
		}
		.command-topline,
		form {
			padding-left: 0.65rem;
			padding-right: 0.65rem;
		}
		.load-command > span {
			flex-wrap: wrap;
		}
	}
	@media (hover: none) {
		.pin-command {
			opacity: 1;
		}
	}
	@media (forced-colors: active) {
		.highlight-viewport {
			display: none;
		}
		textarea {
			color: CanvasText;
			caret-color: auto;
		}
	}
</style>
