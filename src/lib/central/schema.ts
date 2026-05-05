import type { ApiSchema } from './types';

export const apiSchema: ApiSchema = {
	versionMatcher: '/v{version:[0-9.]+}',
	config: {
		rootDir: './',
		maxDepth: 4,
		excludedDirs: ['.gocache', 'node_modules', '.jj', '.git']
	},
	routes: [
		{
			method: 'GET',
			path: '/',
			versioned: true,
			summary: 'Return the API schema generated from the registered routes'
		},
		{
			method: 'GET',
			path: '/_ping',
			versioned: true,
			summary: 'Health check endpoint'
		},
		{
			method: 'HEAD',
			path: '/_ping',
			versioned: true,
			summary: 'Health check endpoint'
		},
		{
			method: 'GET',
			path: '/ls',
			versioned: true,
			summary: 'List Compose projects and whether a watch resource is active',
			queryParams: [
				{
					name: 'all',
					type: 'boolean',
					description: 'Include stopped Compose projects'
				},
				{
					name: 'filter',
					type: 'string',
					description: 'Repeatable filter expression',
					repeated: true,
					values: ['name=<regex>']
				}
			]
		},
		{
			method: 'POST',
			path: '/up',
			versioned: true,
			summary: 'Start a Compose project; optional watch mode starts a per-project watch resource',
			bodyFields: [
				{
					name: 'path',
					type: 'string',
					description: 'Path relative to the serve root'
				},
				{
					name: 'build',
					type: 'boolean',
					description: 'Build before starting'
				},
				{
					name: 'watch',
					type: 'boolean',
					description: 'Start watch mode after up succeeds'
				},
				{
					name: 'removeOrphans',
					type: 'boolean',
					description: 'Remove containers for services no longer defined in the Compose file'
				},
				{
					name: 'services',
					type: 'string[]',
					description: 'Optional service names'
				}
			]
		},
		{
			method: 'GET',
			path: '/watch/{project}',
			versioned: true,
			summary: 'Stream watch logs for a project as SSE'
		},
		{
			method: 'POST',
			path: '/watch/{project}',
			versioned: true,
			summary: 'Start or restart a watch resource for an already upped project',
			bodyFields: [
				{
					name: 'path',
					type: 'string',
					description: 'Optional project path relative to the serve root'
				}
			]
		},
		{
			method: 'DELETE',
			path: '/watch/{project}',
			versioned: true,
			summary: "Stop a project's watch resource without stopping the running containers"
		}
	]
};
