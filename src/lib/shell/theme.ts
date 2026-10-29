/** Neutral Compose chrome with vivid terminal output and editor syntax. */
export const shellColors = {
	bg: '#000000',
	chrome: '#030303',
	raised: '#070707',
	hover: '#101010',
	border: 'rgba(210, 220, 230, 0.085)',
	control: '#0e1013',
	'border-strong': 'rgba(220, 230, 240, 0.16)',
	focus: '#454c54',
	active: '#151515',
	muted: '#8e98a3',
	subtle: '#626d78',
	text: '#dfe5eb',
	accent: '#79b8ff',
	info: '#a4aeb8',
	success: '#3fda82',
	warning: '#f6c86a',
	danger: '#ff6b73',
	selection: '#203957',
	'syntax-command': '#79b8ff',
	'syntax-keyword': '#d2a8ff',
	'syntax-string': '#a5e075',
	'syntax-variable': '#ffc96b',
	'syntax-operator': '#ff937d',
	'syntax-option': '#8be2e8'
} as const;

// Use the dashboard's live tokens for chrome; xterm needs literal canvas colors.
const chromeColors = {
	...shellColors,
	bg: 'var(--app-bg)',
	chrome: 'var(--app-surface)',
	raised: 'var(--app-surface-raised)',
	hover: 'var(--app-surface-hover)',
	border: 'var(--app-border)',
	'border-strong': 'var(--app-border-strong)',
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
	foreground: '#d8e0e8',
	cursor: shellColors.text,
	selectionBackground: shellColors.selection,
	black: '#202428',
	red: shellColors.danger,
	green: '#5fe091',
	yellow: shellColors.warning,
	blue: '#70adff',
	magenta: '#c792ea',
	cyan: '#63d9e6',
	white: '#d8e0e8',
	brightBlack: '#7f8c99',
	brightRed: '#ff9298',
	brightGreen: '#87f0ac',
	brightYellow: '#ffdf91',
	brightBlue: '#9bc7ff',
	brightMagenta: '#dfb3ff',
	brightCyan: '#92edf5',
	brightWhite: '#f4f7fb'
};
