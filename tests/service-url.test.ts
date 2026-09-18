import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { composeServiceUrl } from '../src/lib/central/api.ts';

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
