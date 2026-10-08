/// <reference lib="dom" />
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { canBrowseHistory, commandInput, highlightShell } from '../src/lib/shell/command.ts';
import { commandHistoryScope } from '../src/lib/shell/history.ts';
import type { ShellLaunch } from '../src/lib/shell/launch.ts';

test('shell highlighting preserves unfinished input, Unicode, tabs and all whitespace', () => {
	for (const source of [
		'',
		'echo "Hello $USER" | grep --color=auto Hello # comment',
		"printf '%s\\n' 'a \\ b'",
		'if [ -d "$HOME" ]; then\n\tcd "$HOME"; fi',
		'NAME=value echo 你好 🙂',
		'echo "unfinished ${HOME',
		'echo $(pwd) && cat <input >output',
		'echo <script>alert(1)</script>',
		'echo a#b \\#literal # comment\nls'
	]) {
		const tokens = highlightShell(source);
		assert.equal(tokens.map((token) => token.text).join(''), source);
		let end = 0;
		for (const token of tokens) {
			assert.equal(token.start, end);
			assert(token.text.length > 0);
			end += token.text.length;
		}
	}
	const tokens = highlightShell('echo "$HOME" | ls -a # comment');
	for (const [text, kind] of [
		['echo', 'command'],
		['$HOME', 'variable'],
		['|', 'operator'],
		['ls', 'command'],
		['-a', 'option'],
		['# comment', 'comment']
	])
		assert(tokens.some((token) => token.text === text && token.kind === kind));
	assert(!highlightShell("echo '$HOME'").some((token) => token.kind === 'variable'));
	assert(!highlightShell('echo a#b \\#literal').some((token) => token.kind === 'comment'));
});

test('command submission honors bracketed paste and normalizes multiline and escape bytes', () => {
	assert.equal(commandInput('echo 你好', false), 'echo 你好\r');
	assert.equal(
		commandInput('echo a\r\necho b\necho c', true),
		'\x1b[200~echo a\recho b\recho c\x1b[201~\r'
	);
	assert.equal(
		commandInput('echo \x1b[201~literal', true),
		'\x1b[200~echo [201~literal\x1b[201~\r'
	);
});

test('history navigation keeps multiline cursor movement and selections native', () => {
	assert(canBrowseHistory('draft', 5, 5, 'older'));
	assert(canBrowseHistory('draft', 5, 5, 'newer'));
	assert(!canBrowseHistory('draft', 0, 5, 'older'));
	assert(canBrowseHistory('first\nsecond', 2, 2, 'older'));
	assert(!canBrowseHistory('first\nsecond', 8, 8, 'older'));
	assert(!canBrowseHistory('first\nsecond', 2, 2, 'newer'));
	assert(canBrowseHistory('first\nsecond', 8, 8, 'newer'));
});

test('command history scopes share target sessions but isolate replicas, VM, API and demo', () => {
	const launch: ShellLaunch = {
		serverUrl: '',
		apiVersion: '1.24',
		target: {
			kind: 'container',
			project: 'demo',
			service: 'web',
			containerId: 'replica-1',
			path: '/compose.yml',
			name: 'Web'
		}
	};
	const scope = commandHistoryScope(launch, 'live', 'https://compose.localhost');
	assert.equal(
		scope,
		commandHistoryScope(
			{ ...launch, newSession: true, target: { ...launch.target, name: 'Renamed' } } as ShellLaunch,
			'live',
			'https://compose.localhost'
		)
	);
	assert.notEqual(scope, commandHistoryScope(launch, 'demo', 'https://compose.localhost'));
	assert.notEqual(scope, commandHistoryScope(launch, 'live', 'https://other.localhost'));
	assert.notEqual(
		scope,
		commandHistoryScope({ ...launch, target: { kind: 'vm' } }, 'live', 'https://compose.localhost')
	);
	assert.notEqual(
		scope,
		commandHistoryScope(
			{ ...launch, target: { ...launch.target, containerId: 'replica-2' } } as ShellLaunch,
			'live',
			'https://compose.localhost'
		)
	);
});
