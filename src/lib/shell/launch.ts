import type { ComposeProject, ComposeService, UiState } from '../central/types';

export type ShellConfig = Pick<UiState, 'serverUrl' | 'apiVersion'>;
export type ShellTarget =
	| { kind: 'vm' }
	| {
			kind: 'container';
			project: string;
			service: string;
			containerId?: string;
			path: string;
			name: string;
	  };
export type ShellLaunch = ShellConfig & { target: ShellTarget };

export function containerShellTarget(
	project: ComposeProject,
	service: ComposeService
): ShellTarget {
	return {
		kind: 'container',
		project: project.id,
		service: service.serviceName,
		...(service.containerId ? { containerId: service.containerId } : {}),
		path: service.composePath || project.path,
		name: service.containerName || service.serviceName
	};
}

export function shellActionLabel(state: ComposeService['state']) {
	if (state === 'running') return 'Open shell';
	if (state === 'paused') return 'Resume and open shell';
	if (state === 'restarting') return 'Open shell when running';
	return 'Start and open shell';
}

export function shellHref(base: string, config: ShellConfig, target: ShellTarget) {
	// Launch metadata belongs in the fragment, never credentials or session tickets.
	const launch: ShellLaunch = {
		serverUrl: config.serverUrl,
		apiVersion: config.apiVersion,
		target
	};
	return `${base}/shell/#${encodeURIComponent(JSON.stringify(launch))}`;
}

export function shellApiBase(config: ShellConfig, origin: string) {
	const url = new URL(config.serverUrl.trim() || origin, origin);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
		throw new Error('The shell API must use an HTTP or HTTPS URL without embedded credentials.');
	}
	if (url.search || url.hash)
		throw new Error('The shell API URL cannot contain a query or fragment.');
	if (!/^v?\d+(?:\.\d+)*$/i.test(config.apiVersion)) {
		throw new Error('The shell API version is invalid.');
	}
	return `${url.href.replace(/\/+$/, '')}/v${config.apiVersion.replace(/^v/i, '')}/shell/sessions`;
}

export function parseShellLaunch(hash: string, origin: string): ShellLaunch {
	if (!hash || hash === '#')
		throw new Error('Open a shell from a container or the VM Shell button.');
	let value: unknown;
	try {
		value = JSON.parse(decodeURIComponent(hash.replace(/^#/, '')));
	} catch {
		throw new Error('This shell link is invalid. Open a new shell from Compose Control.');
	}
	if (!value || typeof value !== 'object') throw new Error('This shell link is invalid.');
	const launch = value as Partial<ShellLaunch>;
	if (typeof launch.serverUrl !== 'string' || typeof launch.apiVersion !== 'string') {
		throw new Error('This shell link has no API connection settings.');
	}
	shellApiBase(launch as ShellConfig, origin);
	const target = launch.target;
	if (!target || (target.kind !== 'vm' && target.kind !== 'container')) {
		throw new Error('This shell link has no valid target.');
	}
	if (target.kind === 'container') {
		for (const field of ['project', 'service', 'path', 'name'] as const) {
			if (typeof target[field] !== 'string' || !target[field].trim()) {
				throw new Error(`This shell link has no container ${field}.`);
			}
		}
		if (target.containerId !== undefined && typeof target.containerId !== 'string') {
			throw new Error('This shell link has an invalid container ID.');
		}
	}
	// Pick known fields so a crafted fragment cannot inject command, user, or environment options.
	return {
		serverUrl: launch.serverUrl,
		apiVersion: launch.apiVersion,
		target:
			target.kind === 'vm'
				? { kind: 'vm' }
				: {
						kind: 'container',
						project: target.project,
						service: target.service,
						path: target.path,
						name: target.name,
						...(target.containerId ? { containerId: target.containerId } : {})
					}
	};
}
