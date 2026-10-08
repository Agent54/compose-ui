import type { Reroute } from '@sveltejs/kit';

// Keep file-based static hosting compatible with the standalone Svelte route.
export const reroute: Reroute = ({ url }) => {
	if (url.pathname.endsWith('/shell/index.html')) {
		return url.pathname.slice(0, -'index.html'.length);
	}
};
