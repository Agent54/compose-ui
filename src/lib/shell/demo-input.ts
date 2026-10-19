export type DemoLine = {
	input: string;
	cursor: number;
	commands: string[];
	historyIndex: number;
	draft: string;
};
type Key =
	| 'up'
	| 'down'
	| 'left'
	| 'right'
	| 'home'
	| 'end'
	| 'backspace'
	| 'delete'
	| 'kill-start'
	| 'kill-end'
	| 'kill-word'
	| 'enter'
	| 'interrupt'
	| 'clear'
	| 'eof';
export type DemoInput = { key: Key } | { text: string };

const controls: Record<string, Key> = {
	'\r': 'enter',
	'\n': 'enter',
	'\x03': 'interrupt',
	'\x04': 'eof',
	'\x01': 'home',
	'\x05': 'end',
	'\x02': 'left',
	'\x06': 'right',
	'\x10': 'up',
	'\x0e': 'down',
	'\x0c': 'clear',
	'\x15': 'kill-start',
	'\x0b': 'kill-end',
	'\x17': 'kill-word',
	'\x7f': 'backspace',
	'\b': 'backspace'
};
const sequences: Record<string, Key> = {
	'[A': 'up',
	'[B': 'down',
	'[C': 'right',
	'[D': 'left',
	OH: 'home',
	OF: 'end',
	OA: 'up',
	OB: 'down',
	OC: 'right',
	OD: 'left',
	'[H': 'home',
	'[F': 'end',
	'[1~': 'home',
	'[4~': 'end',
	'[7~': 'home',
	'[8~': 'end',
	'[3~': 'delete'
};

/** Decode terminal keyboard input only in the demo; live input goes straight to its PTY. */
export class DemoInputDecoder {
	private escape = '';
	feed(text: string): DemoInput[] {
		const input: DemoInput[] = [];
		let printable = '';
		const flush = () => {
			if (printable) input.push({ text: printable });
			printable = '';
		};
		for (const char of text) {
			if (char === '\x1b') {
				flush();
				this.escape = char;
			} else if (this.escape) {
				this.escape += char;
				if (this.escape.length > 64) this.escape = '\x1b[?';
				if (this.escape === '\x1b[' || this.escape === '\x1bO') continue;
				if (this.escape.startsWith('\x1b[') && /[0-? -/]/.test(char)) continue;
				const key = sequences[this.escape.slice(1)];
				if (key) input.push({ key });
				// Unknown sequences are consumed, never echoed as printable command text.
				this.escape = '';
			} else if (controls[char]) {
				flush();
				input.push({ key: controls[char] });
			} else if (char >= ' ') printable += char;
		}
		flush();
		return input;
	}
}

export function demoLine(value: Partial<DemoLine> = {}): DemoLine {
	const input = Array.from(typeof value.input === 'string' ? value.input : '')
		.slice(0, 4096)
		.join('');
	const length = Array.from(input).length;
	const commands = Array.isArray(value.commands)
		? value.commands.filter((command) => typeof command === 'string' && command.length > 0)
		: [];
	return {
		input,
		cursor:
			Number.isInteger(value.cursor) && value.cursor! >= 0 && value.cursor! <= length
				? value.cursor!
				: length,
		commands,
		historyIndex:
			Number.isInteger(value.historyIndex) &&
			value.historyIndex! >= 0 &&
			value.historyIndex! <= commands.length
				? value.historyIndex!
				: commands.length,
		draft: typeof value.draft === 'string' ? value.draft : ''
	};
}

export function editDemoLine(line: DemoLine, input: DemoInput) {
	if ('key' in input && (input.key === 'up' || input.key === 'down')) {
		if (input.key === 'up') {
			if (!line.historyIndex) return;
			if (line.historyIndex === line.commands.length) line.draft = line.input;
			line.historyIndex--;
		} else {
			if (line.historyIndex === line.commands.length) return;
			line.historyIndex++;
		}
		line.input = line.commands[line.historyIndex] ?? line.draft;
		line.cursor = Array.from(line.input).length;
		return;
	}
	const chars = Array.from(line.input);
	if ('text' in input) {
		const text = Array.from(input.text).slice(0, 4096 - chars.length);
		chars.splice(line.cursor, 0, ...text);
		line.cursor += text.length;
	} else
		switch (input.key) {
			case 'left':
				line.cursor = Math.max(0, line.cursor - 1);
				break;
			case 'right':
				line.cursor = Math.min(chars.length, line.cursor + 1);
				break;
			case 'home':
				line.cursor = 0;
				break;
			case 'end':
				line.cursor = chars.length;
				break;
			case 'backspace':
				if (line.cursor) chars.splice(--line.cursor, 1);
				break;
			case 'delete':
			case 'eof':
				chars.splice(line.cursor, 1);
				break;
			case 'kill-start':
				chars.splice(0, line.cursor);
				line.cursor = 0;
				break;
			case 'kill-end':
				chars.splice(line.cursor);
				break;
			case 'kill-word': {
				const end = line.cursor;
				while (line.cursor && /\s/.test(chars[line.cursor - 1])) line.cursor--;
				while (line.cursor && !/\s/.test(chars[line.cursor - 1])) line.cursor--;
				chars.splice(line.cursor, end - line.cursor);
				break;
			}
		}
	line.input = chars.join('');
}

// Cell widths for the demo's common CJK/emoji and combining input. Real line editing belongs to the shell.
function cells(text: string, cols: number) {
	let width = 0;
	// eslint-disable-next-line no-control-regex -- ANSI prompt styling occupies no terminal cells.
	for (const char of text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')) {
		if (/[\p{Mark}\p{Cf}]/u.test(char)) continue;
		const code = char.codePointAt(0)!;
		const size =
			code >= 0x1100 &&
			(code <= 0x115f ||
				code === 0x2329 ||
				code === 0x232a ||
				(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
				(code >= 0xac00 && code <= 0xd7a3) ||
				(code >= 0xf900 && code <= 0xfaff) ||
				(code >= 0xfe10 && code <= 0xfe19) ||
				(code >= 0xfe30 && code <= 0xfe6f) ||
				(code >= 0xff00 && code <= 0xff60) ||
				(code >= 0xffe0 && code <= 0xffe6) ||
				(code >= 0x1f300 && code <= 0x1faff) ||
				(code >= 0x20000 && code <= 0x3fffd))
				? 2
				: 1;
		if (size === 2 && width % cols === cols - 1) width++;
		width += size;
	}
	return width;
}
function cursorRow(line: Pick<DemoLine, 'input' | 'cursor'>, prompt: string, cols: number) {
	const chars = Array.from(line.input);
	const offset = cells(prompt + chars.slice(0, line.cursor).join(''), cols);
	return Math.floor(Math.max(0, offset - (line.cursor === chars.length ? 1 : 0)) / cols);
}
export function demoCursor(line: Pick<DemoLine, 'input' | 'cursor'>, prompt: string, cols: number) {
	if (line.cursor === Array.from(line.input).length) return '';
	const endRow = cursorRow(
		{ input: line.input, cursor: Array.from(line.input).length },
		prompt,
		cols
	);
	const row = cursorRow(line, prompt, cols);
	const col = cells(prompt + Array.from(line.input).slice(0, line.cursor).join(''), cols) % cols;
	return `\r${endRow > row ? `\x1b[${endRow - row}A` : ''}${col ? `\x1b[${col}C` : ''}`;
}
export function redrawDemoLine(
	before: Pick<DemoLine, 'input' | 'cursor'>,
	line: DemoLine,
	prompt: string,
	cols: number
) {
	const row = cursorRow(before, prompt, cols);
	return `\r${row ? `\x1b[${row}A` : ''}\x1b[J${prompt}${line.input}${demoCursor(line, prompt, cols)}`;
}
