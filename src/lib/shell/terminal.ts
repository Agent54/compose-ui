import { ShellTransport, type ShellStatus } from './transport';
import type { ShellLaunch } from './launch';
import { DemoShellBackend } from './demo';
import { commandInput } from './command';
import {
	LiveShellBackend,
	ShellBackendUnavailable,
	type ShellBackend,
	type ShellSelection,
	type ShellSession
} from './session';

export type ShellSessionState = {
	sessions: ShellSession[];
	activeId: string;
	backend: 'live' | 'demo';
	demoReason: string;
	error: string;
};

export type ShellTerminal = {
	reconnect(): Promise<void>;
	newSession(): Promise<void>;
	attachSession(id: string): Promise<void>;
	closeSession(id: string): Promise<void>;
	refreshSessions(): Promise<void>;
	retryLive(): Promise<void>;
	sendCommand(text: string): boolean;
	search(text: string, previous?: boolean): boolean;
	zoom(delta: number): void;
	screenReader(enabled: boolean): void;
	focus(): void;
	dispose(): void;
};

export async function createShellTerminal(
	element: HTMLElement,
	launch: ShellLaunch,
	callbacks: {
		status: (status: ShellStatus) => void;
		dimensions: (cols: number, rows: number) => void;
		find: () => void;
		sessions: (state: ShellSessionState) => void;
	}
): Promise<ShellTerminal> {
	// Browser-only imports keep terminal code out of prerendering and the dashboard bundle.
	const [{ Terminal }, { FitAddon }, { SearchAddon }, { WebLinksAddon }, { Unicode11Addon }] =
		await Promise.all([
			import('@xterm/xterm'),
			import('@xterm/addon-fit'),
			import('@xterm/addon-search'),
			import('@xterm/addon-web-links'),
			import('@xterm/addon-unicode11')
		]);
	const terminal = new Terminal({
		// Required by the official Unicode 11 addon; dependency versions are pinned together.
		allowProposedApi: true,
		fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
		fontSize: 14,
		lineHeight: 1.2,
		cursorBlink: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
		cursorStyle: 'bar',
		scrollback: 10000,
		minimumContrastRatio: 4.5,
		disableStdin: true,
		theme: {
			background: '#070b10',
			foreground: '#dfe5eb',
			cursor: '#7fc4ea',
			selectionBackground: '#28445d',
			black: '#18222e',
			red: '#e07b7b',
			green: '#8acb91',
			yellow: '#e1bc79',
			blue: '#7fb1e3',
			magenta: '#b49ad8',
			cyan: '#7fc4ca',
			white: '#dfe5eb',
			brightBlack: '#697786',
			brightRed: '#f09b9b',
			brightGreen: '#a2e3a9',
			brightYellow: '#f1d299',
			brightBlue: '#9bc9fa',
			brightMagenta: '#d1b5f2',
			brightCyan: '#a1e0e6',
			brightWhite: '#ffffff'
		}
	});
	const fit = new FitAddon();
	const search = new SearchAddon();
	terminal.loadAddon(fit);
	terminal.loadAddon(search);
	terminal.loadAddon(new Unicode11Addon());
	terminal.unicode.activeVersion = '11';
	terminal.loadAddon(
		new WebLinksAddon((event, uri) => {
			if (!(event.ctrlKey || event.metaKey)) return;
			try {
				const url = new URL(uri);
				if (['http:', 'https:'].includes(url.protocol))
					window.open(url.href, '_blank', 'noopener,noreferrer');
			} catch {
				/* Ignore non-URL terminal output. */
			}
		})
	);
	terminal.open(element);
	fit.fit();
	callbacks.dimensions(terminal.cols, terminal.rows);
	let disposed = false;
	let webgl: { dispose(): void } | undefined;
	let transport: ShellTransport | undefined;
	let backend: ShellBackend = new LiveShellBackend(launch, window.location.origin);
	let activeId = '';
	let sessions: ShellSession[] = [];
	let demoReason = '';
	let sessionError = '';
	let generation = 0;
	let refreshing = false;
	const lifetime = new AbortController();
	function publish() {
		if (!disposed)
			callbacks.sessions({
				sessions,
				activeId,
				backend: backend.kind,
				demoReason,
				error: sessionError
			});
	}
	async function refreshSessions() {
		if (disposed || refreshing) return;
		refreshing = true;
		const source = backend;
		const revision = generation;
		try {
			const next = await source.list(lifetime.signal);
			if (disposed || source !== backend || revision !== generation) return;
			sessions = next;
			sessionError = '';
			if (activeId && !sessions.some((session) => session.id === activeId)) {
				transport?.dispose();
				activeId = '';
				terminal.options.disableStdin = true;
				callbacks.status({
					phase: 'closed',
					message: 'This session was closed. Select another session or New session.'
				});
			} else if (
				activeId &&
				sessions.find((session) => session.id === activeId)?.state === 'exited'
			) {
				transport?.dispose();
				terminal.options.disableStdin = true;
				callbacks.status({
					phase: 'closed',
					message: 'This session has exited. Select New session or close this session.'
				});
			}
		} catch (error) {
			if (!disposed && source === backend)
				sessionError = error instanceof Error ? error.message : 'Could not list sessions.';
		} finally {
			refreshing = false;
			publish();
			if (!disposed && revision !== generation) void refreshSessions();
		}
	}
	function useDemo(reason: string) {
		let storage: Pick<Storage, 'getItem' | 'setItem'>;
		try {
			storage = window.localStorage;
			const probe = 'compose-shell-storage-probe';
			storage.setItem(probe, '1');
			window.localStorage.removeItem(probe);
		} catch {
			const memory = new Map<string, string>();
			storage = {
				getItem: (key) => memory.get(key) ?? null,
				setItem: (key, value) => {
					memory.set(key, value);
				}
			};
			reason += ' Browser storage is unavailable; demo sessions last only until this tab closes.';
		}
		backend = new DemoShellBackend(launch, storage);
		demoReason = reason;
	}
	const resize = new ResizeObserver(() => {
		if (webgl && (window.devicePixelRatio !== 1 || element.clientWidth < 700)) {
			webgl.dispose();
			webgl = undefined;
		}
		if (!disposed && element.clientWidth && element.clientHeight) fit.fit();
	});
	resize.observe(element);
	terminal.onResize(({ cols, rows }) => {
		callbacks.dimensions(cols, rows);
		transport?.resize(cols, rows);
	});
	terminal.onData((data) => {
		transport?.input(data);
		if (backend.kind === 'demo' && [...data].some((char) => ['\r', '\n', '\x03'].includes(char)))
			void refreshSessions();
	});
	terminal.onBinary((data) => transport?.input(data, true));
	terminal.attachCustomKeyEventHandler((event) => {
		if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyF') {
			if (event.type === 'keydown') {
				event.preventDefault();
				callbacks.find();
			}
			return false;
		}
		return true;
	});
	async function connect(selection: ShellSelection, allowDemo = false) {
		if (disposed) return;
		const current = ++generation;
		transport?.dispose();
		activeId = selection.mode === 'attach' ? selection.sessionId : '';
		terminal.options.disableStdin = true;
		callbacks.status({ phase: 'connecting', message: 'Looking for persistent sessions…' });
		publish();
		try {
			// Probe without creating a real session before choosing a demo fallback.
			if (allowDemo) sessions = await backend.list(lifetime.signal);
			if (disposed || current !== generation) return;
			terminal.reset();
			const connection = new ShellTransport(backend, terminal, (status) => {
				if (disposed || current !== generation) return;
				terminal.options.disableStdin = status.phase !== 'connected';
				if (status.session) activeId = status.session.id;
				callbacks.status(status);
				publish();
				if (
					status.phase === 'connected' &&
					!element.ownerDocument.activeElement?.closest('.command-editor')
				)
					terminal.focus();
				if (status.phase === 'closed') void refreshSessions();
			});
			transport = connection;
			await connection.connect(selection);
			if (current === generation) await refreshSessions();
		} catch (error) {
			if (disposed || current !== generation) return;
			if (allowDemo && backend.kind === 'live' && error instanceof ShellBackendUnavailable) {
				transport?.dispose();
				useDemo(error.message);
				await connect(selection, true);
			} else {
				callbacks.status({
					phase: 'error',
					message: error instanceof Error ? error.message : 'Could not attach to the session.'
				});
				await refreshSessions();
			}
		}
	}
	// Use DOM on WebKit/high-density/narrow displays to avoid observed GPU glyph sizing errors.
	// Standard-density browsers can use WebGL, with DOM fallback on context loss.
	const webkit =
		/AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);
	if (!webkit && window.devicePixelRatio === 1 && element.clientWidth >= 700)
		void import('@xterm/addon-webgl')
			.then(({ WebglAddon }) => {
				if (
					disposed ||
					window.devicePixelRatio !== 1 ||
					element.clientWidth < 700 ||
					terminal.options.screenReaderMode
				)
					return;
				const addon = new WebglAddon();
				webgl = addon;
				addon.onContextLoss(() => {
					addon.dispose();
					webgl = undefined;
				});
				try {
					terminal.loadAddon(addon);
				} catch {
					addon.dispose();
				}
			})
			.catch(() => {
				/* The default renderer remains available. */
			});
	// Consume the modifier once: reloading a Cmd-opened tab reattaches instead of creating again.
	const initial: ShellSelection = { mode: launch.newSession ? 'create' : 'attach-last' };
	if (launch.newSession) {
		const resume = { ...launch };
		delete resume.newSession;
		window.history.replaceState(
			window.history.state,
			'',
			`#${encodeURIComponent(JSON.stringify(resume))}`
		);
	}
	void connect(initial, true);
	const poll = setInterval(() => {
		if (!document.hidden) void refreshSessions();
	}, 5000);
	const storageChanged = () => {
		if (backend.kind === 'demo') void refreshSessions();
	};
	window.addEventListener('storage', storageChanged);
	return {
		reconnect: () =>
			connect(activeId ? { mode: 'attach', sessionId: activeId } : { mode: 'attach-last' }),
		newSession: () => connect({ mode: 'create' }),
		attachSession: (sessionId) => connect({ mode: 'attach', sessionId }),
		refreshSessions,
		sendCommand: (text) => {
			if (disposed || terminal.options.disableStdin || !text.trim()) return false;
			const sent = transport?.input(commandInput(text, terminal.modes.bracketedPasteMode)) ?? false;
			if (sent) {
				terminal.scrollToBottom();
				void refreshSessions();
			}
			return sent;
		},
		retryLive: async () => {
			backend = new LiveShellBackend(launch, window.location.origin);
			demoReason = '';
			sessions = [];
			await connect({ mode: 'attach-last' }, true);
		},
		closeSession: async (id) => {
			if (disposed) return;
			try {
				await backend.delete(id);
				if (activeId === id) {
					++generation;
					transport?.dispose();
					activeId = '';
					terminal.options.disableStdin = true;
					terminal.reset();
					callbacks.status({
						phase: 'closed',
						message: 'Session closed and deleted. Select another session or New session.'
					});
				}
				await refreshSessions();
			} catch (error) {
				sessionError = error instanceof Error ? error.message : 'Could not close the session.';
				publish();
			}
		},
		search: (text, previous = false) => {
			if (!text) {
				search.clearDecorations();
				terminal.clearSelection();
				return false;
			}
			return previous ? search.findPrevious(text) : search.findNext(text);
		},
		zoom: (delta) => {
			terminal.options.fontSize = Math.max(
				10,
				Math.min(24, (terminal.options.fontSize ?? 14) + delta)
			);
			fit.fit();
		},
		screenReader: (enabled) => {
			if (enabled) {
				webgl?.dispose();
				webgl = undefined;
			}
			terminal.options.screenReaderMode = enabled;
		},
		focus: () => terminal.focus(),
		dispose: () => {
			disposed = true;
			++generation;
			lifetime.abort();
			clearInterval(poll);
			window.removeEventListener('storage', storageChanged);
			resize.disconnect();
			transport?.dispose();
			terminal.dispose();
		}
	};
}
