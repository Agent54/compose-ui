<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { RuntimeStatus, UiState } from '$lib/central/types';
	import { loadDiskUsage, type DiskUsage } from '$lib/central/disk-usage';

	let {
		ui,
		runtime,
		onclose
	}: {
		ui: UiState | undefined;
		runtime: RuntimeStatus | null;
		onclose: () => void;
	} = $props();
	let usage = $state<DiskUsage>({});
	let loading = $state(false);
	let scanning = $state(false);
	let error = $state('');
	let filter = $state('all');
	let showAll = $state(false);
	let mounted = $state(false);
	let initialLoadStarted = false;
	const controllers = new Set<AbortController>();
	const resources = $derived(runtime?.vmResources);
	const total = $derived(resources?.diskTotalBytes);
	const available = $derived(resources?.diskAvailableBytes);
	const used = $derived(
		total !== undefined && available !== undefined ? Math.max(0, total - available) : undefined
	);
	const percent = $derived(total && used !== undefined ? Math.min(100, (used / total) * 100) : 0);
	const items = $derived(
		(usage.report?.items ?? []).filter((item) => filter === 'all' || item.kind === filter)
	);
	const visibleItems = $derived(showAll ? items : items.slice(0, 100));
	const unusedVolumes = $derived(
		usage.inventory?.volumes.filter((volume) => volume.references === 0) ?? []
	);

	function bytes(value: number | undefined) {
		if (value === undefined) return '—';
		if (value === 0) return '0 B';
		const unit = Math.min(4, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))));
		return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
	}
	function time(value: string) {
		return new Date(value).toLocaleString();
	}
	async function refresh(scan = false) {
		if (!ui || loading || scanning) return;
		if (scan) scanning = true;
		else loading = true;
		error = '';
		const controller = new AbortController();
		controllers.add(controller);
		try {
			const result = await loadDiskUsage(ui, scan, controller.signal);
			if (mounted) usage = { ...usage, ...result };
		} catch (cause) {
			if (mounted) error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			controllers.delete(controller);
			if (mounted) {
				loading = false;
				scanning = false;
			}
		}
	}
	$effect(() => {
		if (mounted && ui && !initialLoadStarted) {
			initialLoadStarted = true;
			untrack(() => void refresh());
		}
	});
	onMount(() => {
		mounted = true;
		return () => {
			mounted = false;
			for (const controller of controllers) controller.abort();
		};
	});
</script>

<div class="disk-page">
	<div class="page-heading">
		<div>
			<p class="eyebrow">Shared container VM</p>
			<h2>Disk usage</h2>
		</div>
		<button type="button" onclick={onclose}>Back to projects</button>
	</div>
	<section class="capacity" aria-label="VM disk capacity">
		<div class="capacity-values">
			<div>
				<span>Available for writes</span><strong class:low={available === 0 || percent >= 90}
					>{bytes(available)}</strong
				>
			</div>
			<div><span>Used + reserved</span><strong>{bytes(used)}</strong></div>
			<div><span>Filesystem capacity</span><strong>{bytes(total)}</strong></div>
		</div>
		<div
			class="capacity-track"
			role="meter"
			aria-label="VM disk used and reserved"
			aria-valuemin="0"
			aria-valuemax="100"
			aria-valuenow={percent}
			aria-valuetext={total === undefined
				? 'Unavailable'
				: `${percent.toFixed(1)}% used and reserved`}
		>
			<div class:low={percent >= 90} style:width={`${percent}%`}></div>
		</div>
		<p class="muted">
			Free space and inode counters update at most once a minute. No file scan runs in the
			background.
		</p>
		<div class="capacity-footnotes">
			<p>
				<span>Free inodes</span><strong
					>{resources?.diskFreeInodes?.toLocaleString() ?? '—'} / {resources?.diskTotalInodes?.toLocaleString() ??
						'—'}</strong
				>
			</p>
			<p>
				<span>VM images on your Mac</span><strong
					>{bytes(resources?.diskAllocatedBytes)} allocated</strong
				>
			</p>
		</div>
		<p class="muted">
			Host allocation includes the storage and system overlay images. Deleting Docker data frees
			guest space; host allocation may stay higher until discarded blocks are reclaimed.
		</p>
	</section>

	<section class="disk-section">
		<div class="section-heading">
			<div>
				<h3>Docker inventory</h3>
				<p class="muted">Metadata only; cached for one minute.</p>
			</div>
			<button type="button" onclick={() => void refresh()} disabled={loading || scanning || !ui}
				>{loading ? 'Loading…' : 'Refresh inventory'}</button
			>
		</div>
		{#if usage.inventory}
			<div class="inventory-grid">
				<p>
					<strong>{usage.inventory.imageCount}</strong><span>Images</span><small
						>{usage.inventory.unusedImageCount} without container references</small
					>
				</p>
				<p>
					<strong>{usage.inventory.containerCount}</strong><span>Containers</span><small
						>{usage.inventory.stoppedContainerCount} stopped or never started</small
					>
				</p>
				<p>
					<strong>{usage.inventory.volumes.length}</strong><span>Volumes</span><small
						>{unusedVolumes.length} without container references</small
					>
				</p>
			</div>
			<p class="muted sample-time">Inventory checked {time(usage.inventory.sampledAt)}</p>
		{:else if loading}<p class="muted">Loading Docker metadata…</p>
		{:else}<p class="muted">Inventory unavailable. Refresh after the container VM is ready.</p>{/if}
	</section>

	<section class="disk-section">
		<div class="section-heading">
			<div>
				<h3>Where space goes</h3>
				<p class="muted">Analyze images, writable container layers, volumes, and build cache.</p>
			</div>
			<button
				class="primary"
				type="button"
				onclick={() => void refresh(true)}
				disabled={scanning || loading || !ui}
				>{scanning ? 'Analyzing…' : 'Analyze disk usage'}</button
			>
		</div>
		<p class="muted">
			This scan can read many filesystem entries. Run it when builds are idle. It stops after 60
			seconds and reuses a successful report for five minutes.
		</p>
		{#if scanning}<p role="status" class="scan-status">
				Reading Docker disk usage… You can return to projects while the bounded scan finishes.
			</p>{/if}
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		{#if usage.scanError && !error}<p class="error">Last analysis: {usage.scanError}</p>{/if}
		{#if usage.report}
			<p class="muted sample-time">
				Analysis from {time(usage.report.sampledAt)}{usage.nextScanAt
					? ` · New scan available after ${time(usage.nextScanAt)}`
					: ''}
			</p>
			<div class="table-scroll">
				<table class="summary-table">
					<thead
						><tr><th>Category</th><th>Objects</th><th>Size</th><th>Reclaimable estimate</th></tr
						></thead
					><tbody>
						{#each usage.report.categories as category (category.kind)}<tr
								><th scope="row">{category.label}<small>{category.note}</small></th><td
									>{category.count}<small>{category.candidateCount} candidates</small></td
								><td>{bytes(category.totalBytes)}</td><td>{bytes(category.reclaimableBytes)}</td
								></tr
							>{/each}
					</tbody>
				</table>
			</div>
			<p class="muted">
				Estimates overlap where build cache shares image layers; do not add them together. Logs,
				filesystem overhead, and host project folders are not included. “—” means Docker did not
				report a size.
			</p>
			<div class="section-heading item-heading">
				<h3>Largest objects</h3>
				<label
					>Show <select bind:value={filter}
						><option value="all">All categories</option><option value="images">Images</option
						><option value="containers">Container files</option><option value="volumes"
							>Volumes</option
						><option value="build-cache">Build cache</option></select
					></label
				>
			</div>
			<div class="table-scroll">
				<table>
					<thead
						><tr><th>Object</th><th>Size</th><th>Reclaimable estimate</th><th>Review</th></tr
						></thead
					><tbody>
						{#each visibleItems as item, index (`${item.kind}:${index}`)}<tr
								><th scope="row" class="object-name"
									>{item.name}<small>{item.kind} · {item.detail}</small></th
								><td>{bytes(item.bytes)}</td><td>{bytes(item.reclaimableBytes)}</td><td
									>{item.candidate ? 'Cleanup candidate' : 'In use / retained'}</td
								></tr
							>{/each}
						{#if items.length === 0}<tr><td colspan="4">No objects in this category.</td></tr>{/if}
					</tbody>
				</table>
			</div>
			{#if items.length > 100 && !showAll}<button
					class="show-more"
					type="button"
					onclick={() => (showAll = true)}>Show all {items.length} objects</button
				>{/if}
		{:else if !scanning}<div class="analysis-empty">
				<strong>Sizes have not been analyzed yet</strong>
				<p class="muted">
					The inventory identifies unused objects without reading their contents. Analyze disk usage
					to see sizes and reclaimable estimates.
				</p>
			</div>{/if}
	</section>

	{#if unusedVolumes.length}
		<section class="disk-section">
			<h3>Volumes to review</h3>
			<p class="muted">
				These have no container references. They may still hold project data you want to keep.
			</p>
			<ul class="volume-list">
				{#each unusedVolumes as volume (volume.name)}<li>
						<code>{volume.name}</code><span
							>{volume.project || 'No Compose project label'} · {volume.driver}</span
						>
					</li>{/each}
			</ul>
		</section>
	{/if}

	<section class="disk-section">
		<h3>Grow the VM disk</h3>
		<p>
			Hold Option while opening the Xe Launcher menu, then choose <strong
				>Container VM Disk Size</strong
			>. Enter a whole number from the current capacity up to 4096 GiB, then quit and reopen the
			launcher to apply it.
		</p>
		<p class="muted">
			The default Docker data disk is 20 GiB. Capacity can grow but cannot shrink. The sparse image
			uses host space as data is written; a larger capacity does not free existing data. Restarting
			interrupts containers.
		</p>
	</section>

	<section class="disk-section">
		<h3>Cleanup tasks to integrate</h3>
		<p class="muted">
			Run these against this VM’s Docker daemon. Review candidates before adding deletion controls.
		</p>
		<div class="cleanup-list">
			<div>
				<strong>Old build cache</strong><code>docker builder prune --filter until=168h</code>
				<p>
					Clear unused cache older than a week. Later builds may take longer. For a separate Buildx
					builder, target that builder with buildx prune.
				</p>
			</div>
			<div>
				<strong>Dangling images</strong><code>docker image prune</code>
				<p>
					Remove untagged images that no container references. An optional “all unused images” task
					needs a separate review.
				</p>
			</div>
			<div>
				<strong>Stopped containers</strong><code>docker container prune --filter until=168h</code>
				<p>
					Remove stopped containers created more than a week ago, including their writable files.
					Named volumes remain.
				</p>
			</div>
			<div>
				<strong>Selected unused volumes</strong><code>docker volume rm &lt;reviewed-volume&gt;</code
				>
				<p>
					Offer individual selection, project labels, and a backup step. Unattached volumes may
					contain databases; avoid automatic pruning.
				</p>
			</div>
			<div>
				<strong>Bound container logs</strong><code
					>logging: &#123; driver: local, options: &#123; max-size: "10m", max-file: "3" &#125;
					&#125;</code
				>
				<p>
					Rotate logs to prevent growth. Apply through Compose and recreate the affected containers;
					existing containers keep their old logging configuration.
				</p>
			</div>
		</div>
		<p class="muted">
			Prefer targeted cleanup over a single system prune action. Unused networks reclaim little disk
			space.
		</p>
	</section>
</div>

<style>
	.disk-page {
		padding: 1.5rem;
		overflow-y: auto;
		min-height: 0;
		color: var(--app-text);
	}
	.page-heading,
	.section-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	h2 {
		font-size: 1.65rem;
		font-weight: 650;
		letter-spacing: -0.035em;
		margin: 0;
	}
	h3 {
		font-size: 1rem;
		font-weight: 650;
		margin: 0 0 0.35rem;
	}
	.eyebrow {
		color: var(--app-text-subtle);
		font-size: 0.65rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		margin: 0 0 0.3rem;
	}
	p {
		margin: 0.5rem 0;
		font-size: 0.82rem;
		line-height: 1.6;
	}
	.muted,
	small {
		color: var(--app-text-muted);
		font-size: 0.76rem;
	}
	button,
	select {
		background: var(--app-control);
		border: 1px solid var(--app-border-strong);
		color: var(--app-text);
		border-radius: 0.45rem;
		padding: 0.5rem 0.75rem;
		cursor: pointer;
		font-size: 0.78rem;
	}
	button:hover,
	select:hover {
		background: var(--app-control-hover);
	}
	button:focus-visible,
	select:focus-visible {
		outline: 2px solid #1d9bf0 !important;
		outline-offset: 3px;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.primary {
		border-color: #1d9bf0;
	}
	.capacity {
		margin-top: 1.5rem;
		border: 1px solid var(--app-border-strong);
		border-radius: 0.65rem;
		padding: 1.2rem;
		background: var(--app-surface-raised);
	}
	.capacity-values {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1rem;
	}
	.capacity-values span,
	.capacity-values strong {
		display: block;
	}
	.capacity-values span {
		color: var(--app-text-muted);
		font-size: 0.72rem;
	}
	.capacity-values strong {
		font-size: clamp(1.1rem, 2.5vw, 1.9rem);
		font-weight: 600;
		letter-spacing: -0.035em;
		margin-top: 0.3rem;
	}
	.capacity-track {
		height: 8px;
		background: var(--app-surface-active);
		border-radius: 5px;
		margin: 1.1rem 0;
		overflow: hidden;
	}
	.capacity-track div {
		height: 100%;
		background: #8e98a3;
	}
	.capacity-track div.low {
		background: #dc625f;
	}
	.low,
	.error {
		color: #dc625f;
	}
	.capacity-footnotes {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		border-top: 1px solid var(--app-border);
		margin-top: 0.85rem;
		padding-top: 0.7rem;
	}
	.capacity-footnotes span {
		display: block;
		color: var(--app-text-muted);
		font-size: 0.72rem;
	}
	.capacity-footnotes strong {
		font-size: 0.82rem;
		font-weight: 550;
	}
	.disk-section {
		padding: 1.35rem 0;
		border-bottom: 1px solid var(--app-border);
	}
	.disk-section:last-child {
		border-bottom: 0;
	}
	.inventory-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1rem;
		padding: 0.65rem 0;
	}
	.inventory-grid strong,
	.inventory-grid span,
	.inventory-grid small {
		display: block;
	}
	.inventory-grid strong {
		font-size: 1.6rem;
		font-weight: 550;
	}
	.inventory-grid span {
		font-size: 0.8rem;
	}
	.sample-time {
		font-size: 0.69rem;
	}
	.table-scroll {
		overflow-x: auto;
		margin: 1rem 0;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		font-size: 0.76rem;
		text-align: left;
	}
	th,
	td {
		padding: 0.8rem 0.65rem;
		border-bottom: 1px solid var(--app-border);
		vertical-align: top;
	}
	thead th {
		color: var(--app-text-muted);
		font-size: 0.66rem;
		font-weight: 550;
		white-space: nowrap;
	}
	tbody th {
		font-weight: 550;
		min-width: 180px;
	}
	td {
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	td:last-child {
		white-space: normal;
	}
	th small,
	td small {
		display: block;
		font-weight: 400;
		margin-top: 0.3rem;
		font-size: 0.69rem;
		max-width: 32rem;
	}
	.object-name {
		overflow-wrap: anywhere;
		max-width: 26rem;
	}
	.item-heading {
		margin-top: 1.5rem;
	}
	.item-heading label {
		font-size: 0.72rem;
		color: var(--app-text-muted);
	}
	select {
		margin-left: 0.4rem;
	}
	.analysis-empty {
		padding: 1rem 0;
		max-width: 40rem;
		font-size: 0.82rem;
	}
	.scan-status {
		color: #1d9bf0;
	}
	.volume-list {
		list-style: none;
		padding: 0;
		margin: 1rem 0 0;
	}
	.volume-list li {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.5rem 0;
		flex-wrap: wrap;
		font-size: 0.75rem;
	}
	.volume-list span {
		color: var(--app-text-muted);
	}
	code {
		font-family: 'SF Mono', Monaco, monospace;
		overflow-wrap: anywhere;
	}
	.cleanup-list {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1.1rem 1.5rem;
		margin: 1rem 0;
	}
	.cleanup-list strong,
	.cleanup-list code {
		display: block;
	}
	.cleanup-list strong {
		font-size: 0.82rem;
		font-weight: 550;
	}
	.cleanup-list code {
		color: var(--app-text);
		font-size: 0.7rem;
		margin-top: 0.4rem;
	}
	.cleanup-list p {
		font-size: 0.74rem;
		color: var(--app-text-muted);
	}
	.show-more {
		margin-top: 0.5rem;
	}
	@media (max-width: 700px) {
		.disk-page {
			padding: 1rem;
		}
		.cleanup-list {
			grid-template-columns: 1fr;
		}
		.capacity-values {
			grid-template-columns: 1fr;
			gap: 0.6rem;
		}
		.capacity-values > div {
			display: flex;
			align-items: baseline;
			justify-content: space-between;
			gap: 0.5rem;
		}
		.inventory-grid {
			gap: 0.6rem;
		}
	}
</style>
