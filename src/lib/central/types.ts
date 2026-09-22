export type ApiField = {
	name: string;
	type: string;
	description: string;
	repeated?: boolean;
	values?: string[];
};

export type ApiRoute = {
	method: 'GET' | 'POST' | 'HEAD' | 'DELETE';
	path: string;
	versioned: boolean;
	summary: string;
	queryParams?: ApiField[];
	bodyFields?: ApiField[];
};

export type ApiSchema = {
	versionMatcher: string;
	config: {
		rootDir: string;
		maxDepth: number;
		excludedDirs: string[];
	};
	routes: ApiRoute[];
};

export type ConnectionStatus = 'connecting' | 'connected' | 'error';

export type ComposeProject = {
	id: string;
	name: string;
	path: string;
	state: 'running' | 'exited' | 'uncreated' | 'stopped' | 'paused';
	statusLabel: string;
	containerCount: number;
	watching: boolean;
	expanded: boolean;
	updatedLabel: string;
};

export type ComposeService = {
	id: string;
	containerId: string;
	projectId: string;
	projectName: string;
	name: string;
	serviceName: string;
	containerName: string;
	replica?: string;
	composePath?: string;
	appProtocol?: 'http' | 'https';
	publishedPort?: number;
	state: 'running' | 'exited' | 'paused' | 'created' | 'uncreated' | 'unknown';
	stateText: string;
	health?: 'healthy' | 'unhealthy';
};

export type ComposeProcessSnapshot = {
	id: string;
	projectId: string;
	containerId: string;
	containerName: string;
	serviceName: string;
	replica?: string;
	titles: string[];
	processes: string[][];
};

export type ComposeBuild = {
	id: string;
	projectId: string;
	projectName: string;
	kind?: 'build' | 'watch';
	targetName?: string;
	serviceName?: string;
	status: 'running' | 'succeeded' | 'failed';
	startedAt: string;
	serverStartedAt?: string;
	finishedAt: string | null;
	success: boolean | null;
	streamUrl: string;
};

export type ResourceUsage = {
	cpuPercent?: number;
	memoryBytes?: number;
	memoryLimitBytes?: number;
	memoryPercent?: number;
	networkRxBytes?: number;
	networkTxBytes?: number;
	blockReadBytes?: number;
	blockWriteBytes?: number;
	pidsCurrent?: number;
};

export type ResourceLimits = {
	memoryBytes?: number;
	memoryReservationBytes?: number;
	memorySwapBytes?: number;
	nanoCpus?: number;
	cpuCores?: number;
	cpuPeriod?: number;
	cpuQuota?: number;
	cpuShares?: number;
	cpuCount?: number;
	cpusetCpus?: string;
	pidsLimit?: number;
};

export type ResourceUtilization = {
	memoryLimitPercent?: number;
	cpuLimitPercent?: number;
};

export type ResourceContainer = {
	id: string;
	name: string;
	project: string;
	service: string;
	state: string;
	status: string;
	image: string;
	usage?: ResourceUsage;
	limits?: ResourceLimits;
	utilization?: ResourceUtilization;
};

export type ResourceService = {
	name: string;
	project: string;
	containers: number;
	usage?: ResourceUsage;
	limits?: ResourceLimits;
	utilization?: ResourceUtilization;
};

export type ResourceProjectSummary = {
	name: string;
	project: string;
	services: string[];
	containers: number;
	usage?: ResourceUsage;
	limits?: ResourceLimits;
	utilization?: ResourceUtilization;
};

export type ProjectResources = {
	project: string;
	granularity: string;
	containers?: ResourceContainer[];
	services?: ResourceService[];
	projectSummary?: ResourceProjectSummary;
};

export type HostResources = {
	cpuPercent?: number;
	cpuCount: number;
	memoryUsedBytes?: number;
	memoryTotalBytes: number;
	diskUsedBytes?: number;
	diskTotalBytes?: number;
};

export type RuntimeStatus = {
	phase: string;
	message: string;
	memoryTotalBytes?: number;
	memoryAvailableBytes?: number;
	hostResources?: HostResources;
};

export type LogEntry = {
	id: string;
	projectId: string;
	level: 'ok' | 'info' | 'warn' | 'error';
	time: string;
	message: string;
};

export type LocalSettings = {
	id: 'localstorage';
	expandedProjectIds: string[];
	sidebarWidth?: number;
};

export type UiState = {
	id: 'app';
	serverUrl: string;
	apiVersion: string;
	filter: string;
	sortBy: 'path' | 'name' | 'status';
	autoRefreshPaused: boolean;
	selectedProjectId: string;
	selectedContainerId: string;
	status: ConnectionStatus;
	statusDetail: string;
};
