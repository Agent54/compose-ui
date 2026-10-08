export type ShellToken = {
	start: number;
	text: string;
	kind: 'plain' | 'command' | 'keyword' | 'string' | 'variable' | 'operator' | 'comment' | 'option';
};

const keywords = new Set(
	'if then else elif fi for while until do done case esac in function select time coproc'.split(' ')
);

/** Lossless, tolerant highlighting for an unfinished command, never an execution parser. */
export function highlightShell(source: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let offset = 0;
	let command = true;
	let quote = '';
	function add(end: number, kind: ShellToken['kind']) {
		tokens.push({ start: offset, text: source.slice(offset, end), kind });
		offset = end;
	}
	while (offset < source.length) {
		const rest = source.slice(offset);
		const char = source[offset];
		if (quote === "'") {
			const end = source.indexOf("'", offset);
			add(end < 0 ? source.length : end + 1, 'string');
			quote = '';
			continue;
		}
		if (char === '\\') {
			add(Math.min(offset + 2, source.length), quote ? 'string' : 'plain');
			continue;
		}
		if (char === '$') {
			const variable = rest.match(/^\$(?:\{[^}]*\}?|[A-Za-z_][\w]*|[0-9@*#?$!_-])/);
			if (variable) {
				add(offset + variable[0].length, 'variable');
				continue;
			}
		}
		if (quote === '"') {
			if (char === '"') {
				add(offset + 1, 'string');
				quote = '';
			} else {
				const end = rest.search(/["$\\]/);
				add(offset + (end > 0 ? end : end === 0 ? 1 : rest.length), 'string');
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			command = false;
			add(offset + 1, 'string');
			continue;
		}
		if (char === '#' && (offset === 0 || /[\s;|&()]/.test(source[offset - 1]))) {
			const end = source.indexOf('\n', offset);
			add(end < 0 ? source.length : end, 'comment');
			continue;
		}
		const whitespace = rest.match(/^\s+/);
		if (whitespace) {
			if (whitespace[0].includes('\n')) command = true;
			add(offset + whitespace[0].length, 'plain');
			continue;
		}
		const operator = rest.match(/^(?:\$\(|&&|\|\||>>|<<-?|[;&|<>()`])/);
		if (operator) {
			if (/[;|&(`]/.test(operator[0])) command = true;
			add(offset + operator[0].length, 'operator');
			continue;
		}
		const word = rest.match(/^[^\s'"$\\;&|<>()`]+/);
		if (!word) {
			add(offset + 1, 'plain');
			continue;
		}
		const text = word[0];
		const assignment = command && /^[A-Za-z_]\w*=/.test(text);
		const kind = keywords.has(text)
			? 'keyword'
			: assignment
				? 'variable'
				: command
					? 'command'
					: text.startsWith('-')
						? 'option'
						: 'plain';
		add(offset + text.length, kind);
		if (!assignment) command = ['then', 'else', 'do', 'time', 'coproc'].includes(text);
	}
	return tokens;
}

/** Match xterm's paste semantics and honor the attached program's bracketed paste mode. */
export function commandInput(text: string, bracketedPaste: boolean): string {
	const pasted = text.replace(/\r?\n/g, '\r').replaceAll('\x1b', '');
	return (bracketedPaste ? `\x1b[200~${pasted}\x1b[201~` : pasted) + '\r';
}

export function canBrowseHistory(
	text: string,
	start: number,
	end: number,
	direction: 'older' | 'newer'
): boolean {
	if (start !== end) return false;
	return direction === 'older'
		? !text.slice(0, start).includes('\n')
		: !text.slice(end).includes('\n');
}
