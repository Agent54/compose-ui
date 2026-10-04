<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import Icon from './Icon.svelte';
	import {
		attributeDiskObjects,
		groupDiskObjects,
		diskServiceLabel,
		type DiskObjectSort,
		type DiskSortDirection
	} from '$lib/central/disk-objects';
	import type { RuntimeStatus, UiState } from '$lib/central/types';
	import { vmDiskMetrics } from '$lib/central/vm-resource-metrics';
	import {
		loadDiskUsage,
		loadDiskCleanup,
		type DiskUsage,
		type DiskItem,
		type DiskCleanup
	} from '$lib/central/disk-usage';

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
	let cleanup = $state<DiskCleanup | null>(null);
	let cleanupLoading = $state(false);
	let cleanupError = $state('');
	let filter = $state('all');
	let sort = $state<DiskObjectSort>('size');
	let direction = $state<DiskSortDirection>('desc');
	let mounted = $state(false);
	let initialLoadStarted = false;
	const controllers = new SvelteSet<AbortController>();
	const expandedRows = new SvelteSet<string>();
	const collapsedGroups = new SvelteSet<string>(['build-cache', 'shared']);
	const resources = $derived(runtime?.vmResources);
	const total = $derived(resources?.diskTotalBytes);
	const available = $derived(resources?.diskAvailableBytes);
	const used = $derived(
		total !== undefined && available !== undefined ? Math.max(0, total - available) : undefined
	);
	const diskMetric = $derived(vmDiskMetrics(resources, bytes)[0]);
	const percent = $derived(Math.min(100, Math.max(0, diskMetric.percent ?? 0)));
	const attributedItems = $derived(attributeDiskObjects(usage.report?.items ?? []));
	const items = $derived(
		attributedItems.filter((item) => filter === 'all' || item.kind === filter)
	);
	const groups = $derived(groupDiskObjects(items, sort, direction));
	const unusedVolumes = $derived(
		usage.inventory?.volumes.filter((volume) => volume.references === 0) ?? []
	);
	const categories = $derived(
		usage.report?.categories ??
			(usage.inventory
				? [
						{
							kind: 'images',
							label: 'Images',
							count: usage.inventory.imageCount,
							candidateCount: usage.inventory.unusedImageCount,
							totalBytes: undefined,
							reclaimableBytes: undefined
						},
						{
							kind: 'containers',
							label: 'Containers',
							count: usage.inventory.containerCount,
							candidateCount: usage.inventory.stoppedContainerCount,
							totalBytes: undefined,
							reclaimableBytes: undefined
						},
						{
							kind: 'volumes',
							label: 'Volumes',
							count: usage.inventory.volumes.length,
							candidateCount: unusedVolumes.length,
							totalBytes: undefined,
							reclaimableBytes: undefined
						}
					]
				: [])
	);
	const kindLabels: Record<string, string> = {
		images: 'Image',
		containers: 'Container',
		volumes: 'Volume',
		'build-cache': 'Build cache'
	};

	function bytes(value: number | undefined) {
		if (value === undefined) return '—';
		if (value === 0) return '0 B';
		const unit = Math.min(4, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))));
		return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
	}
	function time(value: string) {
		return new Date(value).toLocaleString();
	}
	function lastUsed(value: string) {
		return new Date(value).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
	}
	function totalBytes(value: number | undefined, partial: boolean) {
		return `${bytes(value)}${partial ? ' +' : ''}`;
	}
	function status(unused: number, count: number) {
		return unused === count ? 'Unused' : unused === 0 ? 'Retained' : `${unused} of ${count} unused`;
	}
	function toggleRow(id: string) {
		if (expandedRows.has(id)) expandedRows.delete(id);
		else expandedRows.add(id);
	}
	async function refreshCleanup(run = false) {
		if (!ui || cleanupLoading) return;
		cleanupLoading = true;
		cleanupError = '';
		const controller = new AbortController();
		controllers.add(controller);
		try {
			const result = await loadDiskCleanup(ui, run, controller.signal);
			if (!mounted) return;
			const finished = cleanup?.running && !result.running;
			cleanup = result;
			if (run || finished) {
				usage = { ...usage, report: undefined, scanError: undefined };
				if (finished) void refresh();
			}
		} catch (cause) {
			if (mounted) cleanupError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			controllers.delete(controller);
			if (mounted) cleanupLoading = false;
		}
	}
	async function refresh(scan = false) {
		if (!ui || loading || scanning) return;
		if (!scan) void refreshCleanup();
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
	onMount(() => {
		mounted = true;
		const update = () => {
			if (!ui) return;
			if (!initialLoadStarted) {
				initialLoadStarted = true;
				void refresh();
			} else if (cleanup?.running) void refreshCleanup();
		};
		update();
		const timer = setInterval(update, 2000);
		return () => {
			clearInterval(timer);
			mounted = false;
			for (const controller of controllers) controller.abort();
		};
	});
</script>

{#snippet objectCells(item: DiskItem, nested = false)}
	<th scope="row" class="object-name" class:cache-entry={nested} title={item.detail}>
		{#if nested}<code>{item.id?.replace(/^build-cache:/, '') ?? item.name}</code>
		{:else}{item.name}{/if}
		<small>
			{kindLabels[item.kind] ?? item.kind}
			{#if item.services && item.services.length > 1}
				· {item.services.map(diskServiceLabel).join(', ')}
			{/if}
			{#if item.serviceInferred}· Service name match{/if}
			{#if item.kind === 'build-cache'}· {item.detail}{/if}
		</small>
		{#if nested}<small>{item.name}</small>
		{:else if item.kind === 'build-cache' && item.id}
			<small><code>{item.id.replace(/^build-cache:/, '')}</code></small>
		{/if}
	</th>
	<td data-label="Size">{bytes(item.bytes)}</td>
	<td data-label="Reclaimable (est.)">{bytes(item.reclaimableBytes)}</td>
	<td data-label="Last used">
		{#if item.lastUsedAt}<time datetime={item.lastUsedAt}>{lastUsed(item.lastUsedAt)}</time>
		{:else}—{/if}
	</td>
	<td data-label="Status">{item.candidate ? 'Unused' : 'Retained'}</td>
{/snippet}

<div class="disk-page">
	<div class="page-heading">
		<h3>Disk</h3>
		<button type="button" onclick={onclose}>Back to projects</button>
	</div>
	<section class="capacity" data-pressure={diskMetric.pressure} aria-label="VM disk capacity">
		<div class="capacity-values">
			<div>
				<span>Free</span><strong class="disk-free">{bytes(available)}</strong>
			</div>
			<div><span>Used + reserved</span><strong>{bytes(used)}</strong></div>
			<div><span>Capacity</span><strong>{bytes(total)}</strong></div>
		</div>
		<div
			class="capacity-track"
			role="meter"
			aria-label="VM disk used and reserved"
			aria-valuemin="0"
			aria-valuemax="100"
			aria-valuenow={percent}
			aria-valuetext={diskMetric.percent === undefined
				? 'Unavailable'
				: `${percent.toFixed(1)}% used and reserved`}
		>
			<div style:width={`${percent}%`}></div>
		</div>
		<div class="capacity-footnotes">
			<p>
				<span>Free inodes</span><strong
					>{resources?.diskFreeInodes?.toLocaleString() ?? '—'} / {resources?.diskTotalInodes?.toLocaleString() ??
						'—'}</strong
				>
			</p>
			<p>
				<span>Host allocation</span><strong>{bytes(resources?.diskAllocatedBytes)}</strong>
			</p>
		</div>
	</section>

	<section class="disk-section" aria-label="Storage cleanup">
		<div class="section-heading">
			<h3>Cleanup</h3>
			<button
				class="primary"
				type="button"
				onclick={() => void refreshCleanup(true)}
				disabled={cleanupLoading ||
					cleanup?.running ||
					scanning ||
					loading ||
					!ui ||
					runtime?.phase !== 'healthy' ||
					!cleanup}>{cleanup?.running ? 'Cleaning…' : 'Run cleanup'}</button
			>
		</div>
		{#if cleanup}
			<p class="muted">
				Unused images older than {cleanup.imageMinimumAgeHours}h · Cache {cleanup.buildCacheLimit}
				{#if cleanup.buildCacheMinimumFreeDiskPercent !== undefined}
					· Free disk ≥ {cleanup.buildCacheMinimumFreeDiskPercent}%{/if}
				· Every {cleanup.intervalHours}h
			</p>
			<p class="muted sample-time" role="status">
				{#if cleanup.running}Cleaning…
				{:else if cleanup.completedAt}Last run {time(cleanup.completedAt)}
				{:else if cleanup.lastAttemptAt}Last attempt {time(cleanup.lastAttemptAt)}
				{:else}Not run{/if}
				{#if !cleanup.running && cleanup.nextRunAt}
					· Next {time(cleanup.nextRunAt)}{/if}
			</p>
			{#if cleanup.results.length}
				<ul class="cleanup-results">
					{#each cleanup.results as result (result.name)}
						<li>
							<span>{result.name}</span>
							{#if result.error}<span class="error">{result.error}</span>
							{:else}<strong>{bytes(result.reclaimedBytes)} reclaimed</strong>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
		{#if cleanupError}<p class="error" role="alert">{cleanupError}</p>{/if}
	</section>

	<section class="disk-section">
		<div class="section-heading">
			<h3>Docker</h3>
			<div class="actions">
				<button type="button" onclick={() => void refresh()} disabled={loading || scanning || !ui}
					>{loading ? 'Loading…' : 'Refresh'}</button
				>
				<button
					class="primary"
					type="button"
					onclick={() => void refresh(true)}
					disabled={scanning || loading || !ui}
					>{scanning ? 'Analyzing…' : 'Analyze disk usage'}</button
				>
			</div>
		</div>
		<p class="muted sample-time" role="status">
			{scanning ? 'Analyzing…' : usage.report ? time(usage.report.sampledAt) : 'Not analyzed'}
		</p>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		{#if usage.scanError && !error}<p class="error" role="alert">{usage.scanError}</p>{/if}
		{#if categories.length}
			<div class="table-scroll">
				<table class="summary-table">
					<thead
						><tr
							><th>Type</th><th>Objects</th><th>Unused</th><th>Size</th><th>Reclaimable (est.)</th
							></tr
						></thead
					><tbody>
						{#each categories as category (category.kind)}<tr
								><th scope="row"
									>{category.kind === 'containers' ? 'Container files' : category.label}</th
								><td>{category.count}</td><td>{category.candidateCount}</td><td
									>{bytes(category.totalBytes)}</td
								><td>{bytes(category.reclaimableBytes)}</td></tr
							>{/each}
					</tbody>
				</table>
			</div>
		{:else}<p class="muted">{loading ? 'Loading…' : 'Unavailable'}</p>{/if}
		{#if usage.report}
			<div class="section-heading item-heading">
				<h3>Objects</h3>
				<div class="object-controls">
					<label
						>Type
						<select bind:value={filter}>
							<option value="all">All categories</option>
							<option value="images">Images</option>
							<option value="containers">Container files</option>
							<option value="volumes">Volumes</option>
							<option value="build-cache">Build cache</option>
						</select>
					</label>
					<div class="sort-control">
						<label
							>Sort
							<select
								bind:value={sort}
								onchange={() => (direction = sort === 'last-used' ? 'asc' : 'desc')}
							>
								<option value="size">Size</option>
								<option value="reclaimable">Reclaimable</option>
								<option value="last-used">Last used</option>
							</select>
						</label>
						<button
							type="button"
							class="sort-direction"
							aria-label={direction === 'desc' ? 'Sort ascending' : 'Sort descending'}
							title={direction === 'desc' ? 'Descending' : 'Ascending'}
							onclick={() => (direction = direction === 'desc' ? 'asc' : 'desc')}
						>
							<span aria-hidden="true">{direction === 'desc' ? '↓' : '↑'}</span>
						</button>
					</div>
				</div>
			</div>
			<p class="muted object-note">
				Section totals sum reported object sizes; shared layers can overlap. + means some sizes are
				unavailable.
			</p>
			<div class="object-groups">
				{#each groups as group (group.id)}
					<details
						class="object-group"
						open={!collapsedGroups.has(group.id)}
						ontoggle={(event) => {
							if (event.currentTarget.open) collapsedGroups.delete(group.id);
							else collapsedGroups.add(group.id);
						}}
					>
						<summary class="group-summary">
							<span class="group-title">
								<span class="group-chevron"><Icon name="chevron" size={15} /></span>
								<strong>{group.label}</strong>
								<span class="group-count"
									>{group.items.length} {group.items.length === 1 ? 'object' : 'objects'}</span
								>
							</span>
							<span class="group-totals">
								<span
									><small>Size</small><strong>{totalBytes(group.bytes, group.partialBytes)}</strong
									></span
								>
								<span
									><small>Reclaimable (est.)</small><strong
										>{totalBytes(group.reclaimableBytes, group.partialReclaimableBytes)}</strong
									></span
								>
							</span>
						</summary>
						<div class="table-scroll group-body">
							<table class="object-table" aria-label={`${group.label} storage objects`}>
								<colgroup><col class="name-column" /><col /><col /><col /><col /></colgroup>
								<thead
									><tr
										><th>Object</th><th>Size</th><th>Reclaimable (est.)</th><th>Last used</th><th
											>Status</th
										></tr
									></thead
								>
								<tbody>
									{#each group.rows as row (row.id)}
										{@const rowId = JSON.stringify([group.id, row.id])}
										{#if row.items.length === 1}
											<tr>{@render objectCells(row.items[0])}</tr>
										{:else}
											<tr>
												<th scope="row" class="object-name">
													<button
														class="object-toggle"
														type="button"
														aria-expanded={expandedRows.has(rowId)}
														onclick={() => toggleRow(rowId)}
													>
														<Icon name="chevron" size={13} rotated={expandedRows.has(rowId)} />
														<span>{row.name}<small>{row.items.length} cache entries</small></span>
													</button>
												</th>
												<td data-label="Size">{totalBytes(row.bytes, row.partialBytes)}</td>
												<td data-label="Reclaimable (est.)"
													>{totalBytes(row.reclaimableBytes, row.partialReclaimableBytes)}</td
												>
												<td data-label="Last used">
													{#if row.lastUsedAt}<time datetime={row.lastUsedAt}
															>{lastUsed(row.lastUsedAt)}</time
														><small>Latest</small>
													{:else}—{/if}
												</td>
												<td data-label="Status">{status(row.candidateCount, row.items.length)}</td>
											</tr>
											{#if expandedRows.has(rowId)}
												{#each row.items as item, index (item.id ?? `${item.kind}:${item.name}:${index}`)}
													<tr class="entry-row">{@render objectCells(item, true)}</tr>
												{/each}
											{/if}
										{/if}
									{/each}
								</tbody>
							</table>
						</div>
					</details>
				{/each}
				{#if items.length === 0}<p class="muted">No objects</p>{/if}
			</div>
		{/if}
	</section>

	{#if unusedVolumes.length}
		<section class="disk-section">
			<h3>Unused volumes</h3>
			<ul class="volume-list">
				{#each unusedVolumes as volume (volume.name)}<li>
						<code>{volume.name}</code><span
							>{[volume.project, volume.driver].filter(Boolean).join(' · ')}</span
						>
					</li>{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	.disk-page {
		padding: 1.25rem;
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
	h3 {
		font-size: 0.85rem;
		font-weight: 600;
		margin: 0;
	}
	.actions {
		flex-wrap: wrap;
		display: flex;
		gap: 0.5rem;
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
		border-radius: 0.3rem;
		padding: 0.4rem 0.65rem;
		cursor: pointer;
		font-size: 0.78rem;
	}
	button:hover,
	select:hover {
		background: var(--app-control-hover);
	}
	button:focus-visible,
	select:focus-visible,
	summary:focus-visible {
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
		padding: 1rem 0;
		border-bottom: 1px solid var(--app-border);
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
		font-size: 1.3rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		margin-top: 0.3rem;
	}
	.capacity-track {
		height: 4px;
		background: var(--app-surface-active);
		border-radius: 2px;
		margin: 0.9rem 0;
		overflow: hidden;
	}
	.capacity-track div {
		height: 100%;
		background: #8e98a3;
	}
	.capacity[data-pressure='warning'] .disk-free {
		color: #f0c36a;
	}
	.capacity[data-pressure='critical'] .disk-free {
		color: #f28a86;
	}
	.capacity[data-pressure='warning'] .capacity-track div {
		background: #d9a441;
	}
	.capacity[data-pressure='critical'] .capacity-track div {
		background: #dc625f;
	}
	.error {
		color: #dc625f;
	}
	.capacity-footnotes {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.capacity-footnotes p {
		margin: 0;
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
		padding: 1rem 0;
		border-bottom: 1px solid var(--app-border);
	}
	.disk-section:last-child {
		border-bottom: 0;
	}
	.sample-time {
		font-size: 0.69rem;
	}
	.table-scroll {
		overflow-x: auto;
		margin: 0.65rem 0 0;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		font-size: 0.76rem;
		text-align: left;
	}
	th,
	td {
		padding: 0.6rem;
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
		min-width: 130px;
	}
	td {
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.summary-table td,
	.summary-table thead th:not(:first-child) {
		text-align: right;
	}
	th small {
		display: block;
		font-weight: 400;
		margin-top: 0.15rem;
		font-size: 0.69rem;
		max-width: 32rem;
	}
	.object-name {
		overflow-wrap: anywhere;
		max-width: 26rem;
	}
	td small {
		display: block;
		font-size: 0.66rem;
		margin-top: 0.15rem;
	}
	.item-heading {
		margin-top: 1.25rem;
	}
	.object-controls {
		display: flex;
		align-items: center;
		gap: 0.5rem 0.75rem;
		flex-wrap: wrap;
	}
	.sort-control {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.object-note {
		font-size: 0.69rem;
		margin: 0.65rem 0 1rem;
	}
	.object-groups {
		display: grid;
		gap: 1.25rem;
	}
	.group-summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem 1.5rem;
		padding: 0.55rem 0.2rem;
		border-radius: 0.3rem;
		cursor: pointer;
		list-style: none;
	}
	.group-summary::-webkit-details-marker {
		display: none;
	}
	.group-summary:hover {
		background: var(--app-surface-hover);
	}
	.group-title {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		min-width: 0;
		flex-wrap: wrap;
	}
	.group-title strong {
		font-size: 0.88rem;
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.group-chevron {
		display: flex;
		color: var(--app-text-muted);
		flex: none;
	}
	.object-group[open] > summary .group-chevron {
		transform: rotate(90deg);
	}
	.group-body {
		margin: 0 0 0 2.7rem;
	}
	.group-totals {
		display: flex;
		gap: 1.5rem;
		flex: none;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.group-totals small,
	.group-totals strong {
		display: block;
	}
	.group-totals small {
		font-size: 0.64rem;
	}
	.group-totals strong {
		font-size: 0.82rem;
		font-weight: 600;
	}
	.object-table {
		table-layout: fixed;
	}
	.name-column {
		width: 42%;
	}
	.object-table col:nth-child(2) {
		width: 12%;
	}
	.object-table col:nth-child(3) {
		width: 16%;
	}
	.object-table col:nth-child(4) {
		width: 19%;
	}
	.object-table col:nth-child(5) {
		width: 11%;
	}
	.object-table td {
		white-space: normal;
		overflow-wrap: anywhere;
	}
	.object-table th:first-child {
		padding-left: 0;
	}
	.object-table tbody > tr:last-child > th,
	.object-table tbody > tr:last-child > td {
		border-bottom: 0;
	}
	.object-toggle {
		display: flex;
		align-items: baseline;
		gap: 0.35rem;
		text-align: left;
		padding: 0;
		border: 0;
		background: transparent;
		font-size: inherit;
		font-weight: inherit;
		width: 100%;
	}
	.object-toggle span {
		min-width: 0;
	}
	.object-toggle:hover {
		background: transparent;
		color: #1d9bf0;
	}
	.entry-row {
		background: var(--app-surface-raised);
	}
	.object-table .cache-entry {
		padding-left: 1rem;
	}
	.group-count {
		color: var(--app-text-muted);
		font-size: 0.68rem;
		font-weight: 400;
		white-space: nowrap;
	}
	.sort-direction {
		min-width: 2rem;
		font-size: 0.9rem;
		padding: 0.25rem 0.5rem;
	}
	.item-heading label {
		font-size: 0.72rem;
		color: var(--app-text-muted);
	}
	select {
		margin-left: 0.4rem;
	}
	.cleanup-results {
		list-style: none;
		margin: 0.75rem 0 0;
		padding: 0;
		font-size: 0.76rem;
	}
	.cleanup-results li {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		flex-wrap: wrap;
		padding: 0.25rem 0;
	}
	.cleanup-results strong {
		font-weight: 550;
		font-variant-numeric: tabular-nums;
	}
	.cleanup-results .error {
		overflow-wrap: anywhere;
	}
	.volume-list {
		list-style: none;
		padding: 0;
		margin: 0.65rem 0 0;
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
	@media (max-width: 700px) {
		.group-summary {
			flex-wrap: wrap;
			gap: 0.4rem;
		}
		.group-title {
			width: 100%;
		}
		.group-totals {
			margin-left: 1.5rem;
			text-align: left;
			gap: 1.25rem;
		}
		.group-body {
			margin-left: 2.4rem;
		}
		.object-table colgroup {
			display: none;
		}
		.object-controls {
			gap: 0.5rem;
		}
		.object-controls select {
			padding-inline: 0.5rem;
		}
		.object-table,
		.object-table tbody {
			display: block;
		}
		.object-table thead {
			display: none;
		}
		.object-table tr {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			border-bottom: 1px solid var(--app-border);
			padding-bottom: 0.4rem;
		}
		.object-table th,
		.object-table td {
			border-bottom: 0;
			min-width: 0;
			white-space: normal;
		}
		.object-table .object-name {
			grid-column: 1 / -1;
			max-width: none;
		}
		.object-table td {
			padding-top: 0.2rem;
			padding-bottom: 0.35rem;
		}
		.object-table td::before {
			content: attr(data-label);
			display: block;
			color: var(--app-text-muted);
			font-size: 0.66rem;
			margin-bottom: 0.15rem;
		}
		.disk-page {
			padding: 1rem;
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
	}
</style>
