import type { ComposeProject, ComposeService } from './types';

export function composeActionPaths(
	project: Pick<ComposeProject, 'path'>,
	service?: Pick<ComposeService, 'composePath'>
) {
	const groups = new Map<string, string[]>();
	const files = (service?.composePath || project.path)
		.split(',')
		.map((file) => file.trim())
		.filter(Boolean);

	for (const file of new Set(files)) {
		const normalized = file.replaceAll('\\', '/');
		const root = normalized.slice(0, normalized.lastIndexOf('/') + 1);
		const group = groups.get(root) ?? [];
		group.push(file);
		groups.set(root, group);
	}

	return [...groups.values()].map((group) => group.join(','));
}

export function composeStartupPaths(
	project: Pick<ComposeProject, 'path' | 'watching'>,
	service?: Pick<ComposeService, 'composePath'>,
	watching = project.watching
) {
	const paths = composeActionPaths(project, service);
	return watching && paths.length ? [paths.join(',')] : paths;
}
