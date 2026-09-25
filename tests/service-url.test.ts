import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { composeServiceRoute, composeServiceUrl } from '../src/lib/central/api.ts';

test('service URLs are project-qualified to avoid ambiguous Compose service names', () => {
	assert.equal(
		composeServiceUrl({ serviceName: 'web', projectName: 'demo' }),
		'//web_demo.localhost/'
	);
	assert.equal(
		new URL(composeServiceUrl({ serviceName: 'web', projectName: 'demo' }), 'https://localhost/')
			.href,
		'https://web_demo.localhost/'
	);
});

test('service URLs preserve the Compose replica suffix for scaled services', () => {
	assert.equal(
		composeServiceUrl({ serviceName: 'web', projectName: 'demo', replica: '2' }),
		'//web_demo_2.localhost/'
	);
	assert.equal(
		composeServiceUrl({ serviceName: 'WEB', projectName: 'DEMO', replica: '1' }),
		'//web_demo.localhost/'
	);
});

test('HTTPS service route metadata does not override the UI protocol', () => {
	const route = composeServiceRoute(
		{
			services: {
				darc: {
					ports: [
						{
							name: 'web',
							target: 5194,
							published: '5194',
							protocol: 'tcp',
							app_protocol: 'https'
						}
					]
				}
			}
		},
		'darc'
	);

	assert.deepEqual(route, { appProtocol: 'https', publishedPort: 5194 });
	assert.equal(
		composeServiceUrl({ serviceName: 'darc', projectName: 'darc', ...route }),
		'//darc_darc.localhost/'
	);
});

test('service URLs use the same port as the Compose UI', () => {
	const originalWindow = globalThis.window;
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { location: { protocol: 'http:', port: '5196' } }
	});
	try {
		assert.equal(
			new URL(
				composeServiceUrl({ serviceName: 'web', projectName: 'demo' }),
				'http://localhost:5196/'
			).href,
			'http://web_demo.localhost:5196/'
		);
	} finally {
		if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
		else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
	}
});

test('HTTPS UI links use its port and the signed alias for HTTP services', () => {
	const originalWindow = globalThis.window;
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { location: { protocol: 'https:', port: '5194' } }
	});
	try {
		assert.equal(
			new URL(
				composeServiceUrl({ serviceName: 'web', projectName: 'demo' }),
				'https://localhost:5194/'
			).href,
			'https://web_demo.app.localhost:5194/'
		);
		assert.equal(
			new URL(
				composeServiceUrl({ serviceName: 'darc', projectName: 'darc', appProtocol: 'https' }),
				'https://localhost:5194/'
			).href,
			'https://darc_darc.localhost:5194/'
		);
	} finally {
		if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
		else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
	}
});
