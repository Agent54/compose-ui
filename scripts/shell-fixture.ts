/// <reference lib="deno.ns" />
/** Static-host fixture: shell APIs are unavailable, so the browser uses its demo backend.
 * No commands execute. Directory URLs deliberately fail, like the launcher asset gateway.
 * deno run --allow-net=127.0.0.1:5180 --allow-read=build scripts/shell-fixture.ts
 */
const json = (body: unknown, status = 200) => Response.json(body, { status });
Deno.serve({ hostname: '127.0.0.1', port: 5180 }, async (request) => {
	const url = new URL(request.url);
	const path = url.pathname.replace(/^\/v[\d.]+/, '');
	if (path.startsWith('/shell/sessions'))
		return json({ message: 'Demo fixture: live shell backend unavailable' }, 501);
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
				State: name === 'web' ? 'running' : 'exited',
				Status: name === 'web' ? 'Up 5 minutes' : 'Exited (0)',
				Labels: { 'com.docker.compose.project.config_files': '/demo/compose.yml' }
			}))
		);
	if (path === '/builds' || path === '/top/demo') return json([]);
	if (path === '/system' || path === '/resources/demo') return json({});
	if (path === '/runtime-status') return json({ phase: 'running', message: 'Browser fixture' });
	if (path === '/logs/demo') return new Response('');
	if (url.pathname.startsWith('/v')) return json({ message: 'Unsupported fixture API' }, 404);
	try {
		const pathname = decodeURIComponent(url.pathname);
		if (pathname.split('/').includes('..') || pathname.includes('\\'))
			return new Response('Not found', { status: 404 });
		const file = `build${pathname === '/' ? '/index.html' : pathname}`;
		const mime = (
			{
				html: 'text/html',
				js: 'text/javascript',
				css: 'text/css',
				svg: 'image/svg+xml',
				json: 'application/json'
			} as Record<string, string>
		)[file.split('.').at(-1) ?? ''];
		if (!mime) return new Response('Not found', { status: 404 });
		return new Response(await Deno.readFile(file), { headers: { 'content-type': mime } });
	} catch {
		return new Response('Not found', { status: 404 });
	}
});
