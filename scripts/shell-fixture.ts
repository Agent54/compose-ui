/// <reference lib="deno.ns" />
/** Local browser fixture. Simulates shells; never executes a command or starts a container.
 * Run after `deno task build`:
 * deno run --allow-net=127.0.0.1:5180 --allow-read=build scripts/shell-fixture.ts
 */
const encoder = new TextEncoder();
const sessions = new Map<string, { token: string; name: string; socket?: WebSocket }>();
const running = new Set(['demo-web-1']);
const json = (body: unknown, status = 200) => Response.json(body, { status });

Deno.serve({ hostname: '127.0.0.1', port: 5180 }, async (request) => {
	const url = new URL(request.url);
	const path = url.pathname.replace(/^\/v[\d.]+/, '');
	if (path === '/shell/sessions' && request.method === 'POST') {
		const body = await request.json();
		if (body.shell !== 'bash' || !body.startIfStopped || !body.resumeIfPaused)
			return json({ message: 'Invalid shell request' }, 400);
		const id = crypto.randomUUID();
		const token = crypto.randomUUID().replaceAll('-', '');
		const name = body.target.kind === 'vm' ? 'vm' : body.target.name;
		if (body.target.containerId) running.add(body.target.containerId);
		sessions.set(id, { token, name });
		return json({ id, token });
	}
	const sessionRoute = /^\/shell\/sessions\/([\w-]+)(\/stream)?$/.exec(path);
	if (sessionRoute) {
		const id = sessionRoute[1];
		const session = sessions.get(id);
		if (request.method === 'DELETE') {
			if (session?.socket?.readyState === WebSocket.OPEN) session.socket.close();
			sessions.delete(id);
			return new Response(null, { status: 204 });
		}
		const protocols = request.headers
			.get('sec-websocket-protocol')
			?.split(',')
			.map((item) => item.trim());
		if (
			!session ||
			!protocols?.includes(`ticket.${session.token}`) ||
			request.headers.get('origin') !== url.origin
		) {
			return json({ message: 'Invalid connection ticket or origin' }, 403);
		}
		const { socket, response } = Deno.upgradeWebSocket(request, { protocol: 'compose-shell-v1' });
		session.socket = socket;
		session.token = '';
		const write = (text: string) => socket.send(encoder.encode(text));
		const prompt = `\x1b[32m${session.name}\x1b[0m:~$ `;
		let command = '';
		let cols = 80;
		let rows = 24;
		const decoder = new TextDecoder();
		socket.onopen = () => {
			socket.send(JSON.stringify({ type: 'ready', shell: 'bash' }));
			write(
				`\x1b[1mShell protocol fixture\x1b[0m\r\nSimulated PTY · no commands are executed.\r\nTry pwd, unicode, stty size, or exit.\r\n\r\n${prompt}`
			);
		};
		socket.onmessage = async (event) => {
			if (typeof event.data === 'string') {
				const control = JSON.parse(event.data);
				if (control.type === 'resize') {
					cols = control.cols;
					rows = control.rows;
				}
				return;
			}
			const buffer = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
			for (const char of decoder.decode(buffer, { stream: true })) {
				if (char === '\r' || char === '\n') {
					write('\r\n');
					if (command === 'exit') {
						socket.send(JSON.stringify({ type: 'exit', code: 0 }));
						socket.close();
						return;
					}
					if (command === 'pwd') write('/home/demo\r\n');
					else if (command === 'unicode') write('你好 · café · 🙂\r\n');
					else if (command === 'stty size') write(`${rows} ${cols}\r\n`);
					else if (command) write(`Fixture received: ${command}\r\n`);
					command = '';
					write(prompt);
				} else if (char === '\x7f') {
					if (command) {
						command = command.slice(0, -1);
						write('\b \b');
					}
				} else if (char === '\x03') {
					command = '';
					write(`^C\r\n${prompt}`);
				} else if (char >= ' ') {
					command += char;
					write(char);
				}
			}
		};
		socket.onclose = () => sessions.delete(id);
		return response;
	}
	if (path === '/_ping') return new Response('OK');
	if (path === '/ls')
		return json([{ Name: 'demo', ConfigFiles: '/demo/compose.yml', Status: 'running(1)' }]);
	if (path === '/ps/demo')
		return json(
			['web', 'worker'].map((name) => ({
				ID: `demo-${name}-1`,
				Name: `demo-${name}-1`,
				Service: name,
				Project: 'demo',
				State: running.has(`demo-${name}-1`) ? 'running' : 'exited',
				Status: running.has(`demo-${name}-1`) ? 'Up 5 minutes' : 'Exited (0)',
				Labels: { 'com.docker.compose.project.config_files': '/demo/compose.yml' }
			}))
		);
	if (path === '/builds' || path === '/top/demo') return json([]);
	if (path === '/system' || path === '/resources/demo') return json({});
	if (path === '/runtime-status') return json({ phase: 'running', message: 'Browser fixture' });
	if (path === '/logs/demo') return new Response('');
	if (path.startsWith('/v') || url.pathname.startsWith('/v'))
		return json({ message: 'Unsupported fixture API' }, 404);
	try {
		const pathname = decodeURIComponent(url.pathname);
		if (pathname.split('/').includes('..')) return new Response('Not found', { status: 404 });
		const file = `build${pathname}${pathname.endsWith('/') ? 'index.html' : ''}`;
		const bytes = await Deno.readFile(file);
		const extension = file.split('.').at(-1);
		const mime =
			(
				{
					html: 'text/html',
					js: 'text/javascript',
					css: 'text/css',
					svg: 'image/svg+xml',
					json: 'application/json'
				} as Record<string, string>
			)[extension ?? ''] ?? 'application/octet-stream';
		return new Response(bytes, { headers: { 'content-type': mime } });
	} catch {
		return new Response('Not found', { status: 404 });
	}
});
