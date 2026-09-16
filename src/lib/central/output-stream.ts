export type OutputMessage = {
	project?: string;
	stream?: string;
	source?: string;
	message: string;
	time?: string;
};

export function parseOutputMessage(data: string): OutputMessage {
	try {
		const value: unknown = JSON.parse(data);
		if (
			value &&
			typeof value === 'object' &&
			'message' in value &&
			typeof value.message === 'string'
		) {
			return value as OutputMessage;
		}
		if (typeof value === 'string') return { message: value };
	} catch {
		// Plain output and malformed JSON are still useful diagnostic information.
	}
	return { message: data };
}

export function buildCompletion(message: OutputMessage) {
	if (message.stream !== 'status' || message.source !== 'Compose') return undefined;
	if (message.message === 'Build completed') return 'succeeded' as const;
	if (message.message === 'Build failed') return 'failed' as const;
	return undefined;
}

// Build streams replay their full backlog, then close after the terminal status.
// Each attempt is a fresh snapshot; never concatenate replayed output on retries.
export async function readBuildOutput(
	url: string,
	signal: AbortSignal,
	onMessage: (message: OutputMessage, index: number) => void
) {
	const response = await fetch(url, { signal, headers: { accept: 'text/event-stream' } });
	if (!response.ok) {
		throw new Error(`Loading build output failed (${response.status}): ${await response.text()}`);
	}
	if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
		throw new Error('The server did not return a build output stream.');
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const messages: OutputMessage[] = [];
	let buffer = '';
	let data: string[] = [];
	const dispatch = () => {
		if (!data.length) return;
		const message = parseOutputMessage(data.join('\n'));
		data = [];
		messages.push(message);
		onMessage(message, messages.length - 1);
	};
	const line = (value: string) => {
		if (!value) dispatch();
		else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
	};
	try {
		while (true) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			let end: number;
			while ((end = buffer.indexOf('\n')) >= 0) {
				line(buffer.slice(0, end).replace(/\r$/, ''));
				buffer = buffer.slice(end + 1);
			}
			if (done) break;
		}
		if (buffer) line(buffer.replace(/\r$/, ''));
		dispatch();
		if (!messages.some((message) => buildCompletion(message))) {
			throw new Error('Build output disconnected before completion. Retrying…');
		}
		return messages;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
