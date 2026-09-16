import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mergeBuilds, latestBuildFailure } from '../src/lib/central/build-state.ts';
import {
	buildCompletion,
	parseOutputMessage,
	readBuildOutput
} from '../src/lib/central/output-stream.ts';
import type { ComposeBuild } from '../src/lib/central/types.ts';

const project = { id: 'project-id', name: 'app' };
const build: ComposeBuild = {
	id: '1',
	projectId: project.id,
	projectName: project.name,
	kind: 'build',
	status: 'failed',
	success: false,
	startedAt: '2026-09-15T00:00:00Z',
	finishedAt: '2026-09-15T00:01:00Z',
	streamUrl: '/builds/1/stream'
};
const finished = { source: 'Compose', stream: 'status', message: 'Build failed' };

test('failed history survives missing/stale polls and keeps service identity', () => {
	const local = { ...build, serviceName: 'web', targetName: 'web' };
	assert.deepEqual(mergeBuilds([local], []), [local]);
	const [merged] = mergeBuilds(
		[local],
		[{ ...build, projectId: 'app', status: 'running', success: null, finishedAt: null }]
	);
	assert.equal(merged.status, 'failed');
	assert.equal(merged.projectId, project.id);
	assert.equal(merged.serviceName, 'web');
	assert.equal(latestBuildFailure([merged], project)?.id, '1');
});

test('a newer build clears the warning only for its target, retaining failed history', () => {
	const failed = { ...build, serviceName: 'web' };
	const newer = {
		...build,
		id: '2',
		serviceName: 'db',
		status: 'succeeded' as const,
		startedAt: '2026-09-15T00:02:00Z'
	};
	assert.equal(latestBuildFailure([failed, newer], project)?.id, '1');
	assert.equal(latestBuildFailure([failed, newer], project, { serviceName: 'db' }), undefined);
	assert.equal(latestBuildFailure([failed, { ...newer, serviceName: 'web' }], project), undefined);
	assert.equal(
		latestBuildFailure([failed, { ...newer, serviceName: undefined }], project),
		undefined
	);
	assert.equal(latestBuildFailure([failed], { id: 'elsewhere', name: 'elsewhere' }), undefined);
});

test('a reused build ID after server restart does not inherit the old failure or target', () => {
	const previous = { ...build, serviceName: 'web' };
	const incoming = {
		...build,
		projectId: 'other',
		projectName: 'other',
		startedAt: '2026-09-15T02:00:00Z',
		status: 'running' as const,
		success: null,
		finishedAt: null
	};
	assert.deepEqual(mergeBuilds([previous], [incoming]), [incoming]);
	const newSnapshot = { ...incoming, serverStartedAt: incoming.startedAt };
	assert.deepEqual(mergeBuilds([
		{ ...previous, serverStartedAt: previous.startedAt, finishedAt: '2026-09-15T03:00:00Z' }
	], [newSnapshot]), [newSnapshot]);
});

test('only the server terminal status determines build success or failure', () => {
	assert.equal(buildCompletion(finished), 'failed');
	assert.equal(buildCompletion({ ...finished, message: 'Build completed' }), 'succeeded');
	assert.equal(buildCompletion({ ...finished, stream: 'stdout' }), undefined);
	assert.equal(buildCompletion({ ...finished, source: 'web' }), undefined);
	assert.equal(
		buildCompletion({ ...finished, message: 'service(s) successfully built' }),
		undefined
	);
	assert.deepEqual(parseOutputMessage('  compiler diagnostic'), {
		message: '  compiler diagnostic'
	});
	assert.deepEqual(parseOutputMessage('{broken JSON'), { message: '{broken JSON' });
});

async function withResponse(response: Response, run: () => Promise<void>) {
	const original = globalThis.fetch;
	globalThis.fetch = async () => response;
	try {
		await run();
	} finally {
		globalThis.fetch = original;
	}
}

function streamResponse(text: string, splitBytes = 1) {
	const bytes = new TextEncoder().encode(text);
	return new Response(
		new ReadableStream({
			start(controller) {
				for (let i = 0; i < bytes.length; i += splitBytes)
					controller.enqueue(bytes.slice(i, i + splitBytes));
				controller.close();
			}
		}),
		{ headers: { 'content-type': 'text/event-stream' } }
	);
}

test('completed failure replays all output across UTF-8/CRLF boundaries, without losing repeats', async () => {
	const output =
		': keepalive\r\nevent: message\r\ndata: {"message":"  실패 🚨","stream":"stderr"}\r\n\r\n' +
		'data: repeated\n\ndata: repeated\n\ndata: {"message":\ndata: "multi-line JSON"}\n\n' +
		`data: ${JSON.stringify(finished)}`;
	await withResponse(streamResponse(output), async () => {
		const seen: string[] = [];
		const messages = await readBuildOutput(
			'http://test/build',
			new AbortController().signal,
			(message) => seen.push(message.message)
		);
		assert.deepEqual(seen, [
			'  실패 🚨',
			'repeated',
			'repeated',
			'multi-line JSON',
			'Build failed'
		]);
		assert.equal(messages.length, 5);
	});
});

test('disconnects expose partial output and fail instead of silently marking it complete', async () => {
	await withResponse(streamResponse('data: compiler error\n\n'), async () => {
		const seen: string[] = [];
		await assert.rejects(
			readBuildOutput('http://test/build', new AbortController().signal, (message) =>
				seen.push(message.message)
			),
			/disconnected before completion/
		);
		assert.deepEqual(seen, ['compiler error']);
	});
});

test('HTTP and invalid stream responses retain the reason for the UI', async () => {
	await withResponse(new Response('build history expired', { status: 404 }), async () => {
		await assert.rejects(
			readBuildOutput('http://test/build', new AbortController().signal, () => {}),
			/404.*build history expired/
		);
	});
	await withResponse(new Response('<html>Proxy error</html>'), async () => {
		await assert.rejects(
			readBuildOutput('http://test/build', new AbortController().signal, () => {}),
			/did not return a build output stream/
		);
	});
});

test('reader failures keep already delivered diagnostics', async () => {
	let pulled = false;
	const response = new Response(
		new ReadableStream({
			pull(controller) {
				if (pulled) controller.error(new Error('connection reset'));
				else {
					pulled = true;
					controller.enqueue(new TextEncoder().encode('data: last diagnostic\n\n'));
				}
			}
		}),
		{ headers: { 'content-type': 'text/event-stream' } }
	);
	await withResponse(response, async () => {
		const seen: string[] = [];
		await assert.rejects(
			readBuildOutput('http://test/build', new AbortController().signal, (message) =>
				seen.push(message.message)
			),
			/connection reset/
		);
		assert.deepEqual(seen, ['last diagnostic']);
	});
});
