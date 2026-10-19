/** Shared chrome, command editor and ANSI colors for the standalone shell. */
export const shellColors = {
	bg: '#090909',
	chrome: '#101010',
	raised: '#171717',
	hover: '#1e1e1e',
	border: '#1c1c1c',
	focus: '#50504a',
	active: '#252522',
	muted: '#a1a19b',
	text: '#eeeee9',
	accent: '#d0f582',
	info: '#bca7ff',
	success: '#8ee3b5',
	warning: '#f1c77e',
	danger: '#ff858d',
	selection: '#3c4230'
} as const;

export const shellStyles = Object.entries(shellColors)
	.map(([name, value]) => `--shell-${name}:${value}`)
	.join(';');

export const terminalTheme = {
	background: shellColors.bg,
	foreground: shellColors.text,
	cursor: shellColors.accent,
	selectionBackground: shellColors.selection,
	black: '#242424',
	red: shellColors.danger,
	green: shellColors.success,
	yellow: shellColors.warning,
	blue: '#a7b9f4',
	magenta: shellColors.info,
	cyan: '#94d7d6',
	white: shellColors.text,
	brightBlack: '#92928c',
	brightRed: '#ffa3a9',
	brightGreen: '#b4efcb',
	brightYellow: '#f7dca6',
	brightBlue: '#c4d0ff',
	brightMagenta: '#d4c5ff',
	brightCyan: '#b2ebea',
	brightWhite: '#ffffff'
};
