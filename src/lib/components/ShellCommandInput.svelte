<script lang="ts">
	import { tick } from 'svelte';
	import Icon from './Icon.svelte';
	import { canBrowseHistory, highlightShell } from '$lib/shell/command';
	import { CommandHistory, type CommandEntry } from '$lib/shell/history';

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
	let entries = $state.raw<CommandEntry[]>([]);
	let loading = $state(false);
	let more = $state(false);
	let composing = $state(false);
	let scrollLeft = $state(0);
	let scrollTop = $state(0);
	let history: CommandHistory | undefined;
	let textarea: HTMLTextAreaElement;
	let menu: HTMLDetailsElement;
	let selectedId: number | undefined;
	let savedDraft = '';
	let navigation = 0;
	let navigating = false;
	let disposed = false;
	const tokens = $derived(highlightShell(draft + '\n'));
	const rows = $derived(Math.min(6, draft.split('\n').length));

	function mountHistory(node: HTMLDetailsElement) {
		menu = node;
		try {
			history = new CommandHistory(scope);
		} catch {
			historyError = 'Browser storage is unavailable; command history cannot be saved.';
		}
		const outside = (event: PointerEvent) => {
			if (!node.contains(event.target as Node)) node.open = false;
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && node.open && node.contains(document.activeElement)) {
				node.open = false;
				textarea.focus();
			}
		};
		document.addEventListener('pointerdown', outside);
		document.addEventListener('keydown', escape);
		return () => {
			disposed = true;
			++navigation;
			history?.close();
			document.removeEventListener('pointerdown', outside);
			document.removeEventListener('keydown', escape);
		};
	}

	async function loadHistory(older = false) {
		if (!history || loading) return;
		loading = true;
		try {
			const page = await history.page(older ? entries.at(-1)?.id : undefined);
			if (disposed) return;
			entries = older ? [...entries, ...page] : page;
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
		selectedId = undefined;
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
		if (!history || navigating || (direction === 'newer' && selectedId === undefined)) return;
		if (selectedId === undefined) savedDraft = draft;
		const revision = ++navigation;
		navigating = true;
		try {
			const entry = await history.neighbor(selectedId, direction);
			if (disposed || revision !== navigation) return;
			if (entry) {
				selectedId = entry.id;
				await replaceDraft(entry.text);
			} else if (direction === 'newer') {
				selectedId = undefined;
				await replaceDraft(savedDraft);
			}
		} catch {
			if (!disposed) historyError = 'Command history could not be read from this browser.';
		} finally {
			if (revision === navigation) navigating = false;
		}
	}

	function submit() {
		if (composing || !draft.trim()) return;
		const text = draft;
		if (!connected || !onsend(text)) {
			message = 'Connect to a session to send this command. Your draft is kept here.';
			return;
		}
		const record = { text, cwd, sessionId };
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
		} else if (event.key === 'Escape' && menu.open) {
			menu.open = false;
		}
	}
</script>

<section class="command-editor" aria-label="Command editor">
	<div class="command-topline">
		<label for={`${uid}-command`}>Command</label>
		<span class="cwd" title={cwd}>{cwd || 'No active session'}</span>
		<details
			class="history"
			{@attach mountHistory}
			ontoggle={() => {
				if (menu.open) void loadHistory();
			}}
		>
			<summary aria-label="Command history"><span aria-hidden="true">↶</span> History</summary>
			<div class="history-panel">
				<div class="history-heading">
					<strong>Command history</strong><span>Saved in this browser</span>
				</div>
				<ul aria-label="Saved commands">
					{#each entries as entry (entry.id)}
						<li>
							<button
								type="button"
								title="Load command into editor"
								onclick={() => {
									menu.open = false;
									edited();
									void replaceDraft(entry.text);
								}}
								><code>{entry.text}</code><span
									>{entry.cwd || 'Unknown directory'}<time
										datetime={new Date(entry.createdAt).toISOString()}
										>{new Date(entry.createdAt).toLocaleString()}</time
									></span
								></button
							>
						</li>
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
	</div>
	<form
		onsubmit={(event) => {
			event.preventDefault();
			submit();
		}}
	>
		<span class="prompt" aria-hidden="true">❯</span>
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
		<button
			class="send"
			type="submit"
			disabled={!connected || !draft.trim() || composing}
			title="Send command to the attached session"><Icon name="play" size={12} /> Run</button
		>
	</form>
	<div class="command-bottomline" id={`${uid}-help`}>
		<span
			>Enter to send <span class="divider">·</span> Shift + Enter for a new line
			<span class="divider">·</span> ↑ ↓ history</span
		>
	</div>
	{#if message || historyError}<p class="editor-message" role="status">
			{message || historyError}
		</p>{/if}
</section>

<style>
	.command-editor {
		position: relative;
		flex: none;
		margin: 0.5rem 1rem 0.6rem;
		border: 1px solid var(--shell-border);
		border-radius: 0.6rem;
		background: var(--shell-chrome);
	}
	.command-editor:focus-within {
		border-color: #47738e;
		box-shadow: 0 0 0 1px #47738e33;
	}
	.command-topline {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		padding: 0.65rem 0.85rem 0.3rem;
		font-size: 0.68rem;
		color: var(--shell-muted);
	}
	label {
		color: var(--shell-text);
		font-weight: 600;
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
		padding: 0.4rem 0.85rem 0.5rem;
	}
	.prompt {
		color: var(--shell-accent);
		line-height: 1.6;
		padding-top: 0.2rem;
	}
	.editor-field {
		position: relative;
		flex: 1;
		min-width: 0;
		overflow: hidden;
	}
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
		background: #28445d;
		color: #fff;
	}
	textarea::placeholder {
		color: #7f8e9d;
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
		color: #8acb91;
	}
	[data-token='keyword'],
	[data-token='variable'] {
		color: #bfa8e3;
	}
	[data-token='string'] {
		color: #e1bc79;
	}
	[data-token='operator'] {
		color: #7fc4ca;
	}
	[data-token='option'] {
		color: #9bc9fa;
	}
	[data-token='comment'] {
		color: #8998a8;
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
	.send {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		border: 1px solid #344d60;
		border-radius: 0.3rem;
		padding: 0.3rem 0.65rem;
		background: #172b3b;
		color: #b8dcf0;
		font-size: 0.72rem;
	}
	.send:hover:not(:disabled) {
		background: #213c50;
	}
	.command-bottomline {
		padding: 0 0.85rem 0.65rem;
		color: var(--shell-muted);
		font-size: 0.63rem;
	}
	.divider {
		padding: 0 0.3rem;
		color: #4e6478;
	}
	.editor-message {
		margin: 0;
		padding: 0 0.85rem 0.65rem;
		font-size: 0.7rem;
		color: #e1bc79;
	}
	.history {
		flex: none;
	}
	summary {
		list-style: none;
		color: var(--shell-muted);
		padding: 0.2rem 0.1rem;
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
		width: min(36rem, calc(100vw - 2rem));
		padding: 0.7rem;
		border: 1px solid var(--shell-border);
		border-radius: 0.6rem;
		background: #111a24;
		box-shadow: 0 12px 40px #0008;
	}
	.history-heading {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.3rem 0.35rem 0.7rem;
	}
	.history-heading strong {
		color: var(--shell-text);
	}
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
		max-height: min(22rem, 45dvh);
		overflow: auto;
	}
	li button {
		display: block;
		width: 100%;
		padding: 0.65rem 0.5rem;
		text-align: left;
		border: 0;
		border-radius: 0.3rem;
		background: transparent;
		color: var(--shell-text);
	}
	li button:hover {
		background: #1c2b3a;
	}
	code {
		display: block;
		font-size: 0.78rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	li button > span {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: 0.35rem;
		font-size: 0.62rem;
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
		width: 100%;
		margin-top: 0.5rem;
		padding: 0.5rem;
		border: 1px solid var(--shell-border);
		border-radius: 0.3rem;
		background: #162433;
		color: var(--shell-accent);
	}
	@media (max-width: 640px) {
		.command-editor {
			margin: 0.4rem 0.5rem;
		}
		textarea,
		pre {
			font-size: 16px;
		}
		.command-topline,
		form {
			padding-left: 0.65rem;
			padding-right: 0.65rem;
		}
		.command-bottomline {
			padding-left: 0.65rem;
			padding-right: 0.65rem;
			font-size: 0.6rem;
		}
		li button > span {
			flex-wrap: wrap;
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
