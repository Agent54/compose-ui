/** Shell chrome follows Compose; ANSI output keeps subdued semantic colors. */
export const shellColors = {
	bg: '#000000',
	chrome: '#030303',
	raised: '#070707',
	hover: '#101010',
	border: 'rgba(210, 220, 230, 0.085)',
	focus: '#454c54',
	active: '#151515',
	muted: '#8e98a3',
	subtle: '#626d78',
	text: '#dfe5eb',
	accent: '#b7c1ca',
	info: '#a4aeb8',
	success: '#819b8a',
	warning: '#b8a17d',
	danger: '#c48383',
	selection: '#293038'
} as const;

// Use the dashboard's live tokens for chrome; xterm needs literal canvas colors.
const chromeColors = {
	...shellColors,
	bg: 'var(--app-bg)',
	chrome: 'var(--app-surface)',
	raised: 'var(--app-surface-raised)',
	hover: 'var(--app-surface-hover)',
	border: 'var(--app-border)',
	active: 'var(--app-surface-active)',
	muted: 'var(--app-text-muted)',
	subtle: 'var(--app-text-subtle)',
	text: 'var(--app-text)'
};

export const shellStyles = Object.entries(chromeColors)
	.map(([name, value]) => `--shell-${name}:${value}`)
	.join(';');

export const terminalTheme = {
	background: shellColors.bg,
	foreground: '#c2c9d0',
	cursor: shellColors.accent,
	selectionBackground: shellColors.selection,
	black: '#202428',
	red: shellColors.danger,
	green: shellColors.success,
	yellow: shellColors.warning,
	blue: '#8b9eb2',
	magenta: '#a39ba8',
	cyan: '#849fa3',
	white: '#c2c9d0',
	brightBlack: shellColors.subtle,
	brightRed: '#d49696',
	brightGreen: '#9caf9f',
	brightYellow: '#c8b491',
	brightBlue: '#a2b2c3',
	brightMagenta: '#b6acba',
	brightCyan: '#9bb3b6',
	brightWhite: shellColors.text
};
