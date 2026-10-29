export type ServiceActionTarget = { projectId: string; serviceId?: string };
export type ServiceAction = ServiceActionTarget & { kind: string };

export function actionTargetsOverlap(left: ServiceActionTarget, right: ServiceActionTarget) {
	return (
		left.projectId === right.projectId &&
		(!left.serviceId || !right.serviceId || left.serviceId === right.serviceId)
	);
}

export function hasActiveAction(
	actions: readonly ServiceAction[],
	target: ServiceActionTarget,
	kind?: ServiceAction['kind']
) {
	return actions.some(
		(action) => actionTargetsOverlap(action, target) && (!kind || action.kind === kind)
	);
}

// Track requests without scheduling them. The backend owns project serialization.
export class ServiceActionTracker {
	private active = new Set<ServiceAction>();
	private closed = false;

	constructor(private onChange: (active: ServiceAction[]) => void) {}

	acquire(action: ServiceAction): (() => void) | null {
		if (this.closed || hasActiveAction([...this.active], action)) {
			return null;
		}
		this.active.add(action);
		this.notify();
		return () => {
			if (this.active.delete(action)) this.notify();
		};
	}

	close() {
		this.closed = true;
		this.active.clear();
		this.notify();
	}

	private notify() {
		this.onChange([...this.active]);
	}
}
