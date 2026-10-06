import { ShellTransport, type ShellStatus } from './transport';
import type { ShellLaunch } from './launch';

export type ShellTerminal = {
	reconnect(): void;
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
	terminal.onData((data) => transport?.input(data));
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
	function connect() {
		transport?.dispose();
		terminal.options.disableStdin = true;
		transport = new ShellTransport(launch, window.location.origin, terminal, (status) => {
			if (disposed) return;
			terminal.options.disableStdin = status.phase !== 'connected';
			callbacks.status(status);
			if (status.phase === 'connected') terminal.focus();
		});
		void transport.connect();
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
	connect();
	return {
		reconnect: () => {
			if (disposed) return;
			terminal.write('\r\n\x1b[90m── New shell session ──\x1b[0m\r\n');
			connect();
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
			resize.disconnect();
			transport?.dispose();
			terminal.dispose();
		}
	};
}
