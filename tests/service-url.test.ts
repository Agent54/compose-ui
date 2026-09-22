import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { composeServiceRoute, composeServiceUrl } from '../src/lib/central/api.ts';

test('service URLs are project-qualified to avoid ambiguous Compose service names', () => {
	assert.equal(
		composeServiceUrl({ serviceName: 'web', projectName: 'demo' }),
		'http://web_demo.localhost:5196/'
	);
});

test('service URLs preserve the Compose replica suffix for scaled services', () => {
	assert.equal(
		composeServiceUrl({ serviceName: 'web', projectName: 'demo', replica: '2' }),
		'http://web_demo_2.localhost:5196/'
	);
	assert.equal(
		composeServiceUrl({ serviceName: 'WEB', projectName: 'DEMO', replica: '1' }),
		'http://web_demo.localhost:5196/'
	);
});

test('HTTPS service URLs use the published port declared by Compose', () => {
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
		'https://darc_darc.localhost:5194/'
	);
});
