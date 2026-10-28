export type ServiceActionTarget = { projectId: string; serviceId?: string };
export type ServiceAction = ServiceActionTarget & { kind: string };

export function actionTargetsOverlap(left: ServiceActionTarget, right: ServiceActionTarget) {
	return (
		left.projectId === right.projectId &&
		(!left.serviceId || !right.serviceId || left.serviceId === right.serviceId)
	);
}

type Entry = {
	action: ServiceAction;
	resolve: (release: (() => void) | null) => void;
};

// Reserve the active slot synchronously so rapid clicks cannot start competing mutations.
export class ServiceActionQueue {
	private active: Entry | null = null;
	private pending: Entry[] = [];
	private closed = false;

	constructor(private onChange: (active: ServiceAction | null, pending: ServiceAction[]) => void) {}

	acquire(action: ServiceAction): Promise<(() => void) | null> {
		if (
			this.closed ||
			[this.active, ...this.pending].some(
				(entry) => entry && actionTargetsOverlap(entry.action, action)
			)
		) {
			return Promise.resolve(null);
		}
		return new Promise((resolve) => {
			this.pending.push({ action, resolve });
			this.advance();
		});
	}

	close() {
		this.closed = true;
		for (const entry of this.pending.splice(0)) entry.resolve(null);
		this.notify();
	}

	private advance() {
		if (!this.active && !this.closed) {
			const entry = this.pending.shift();
			if (entry) {
				this.active = entry;
				entry.resolve(() => {
					if (this.active !== entry) return;
					this.active = null;
					this.advance();
				});
			}
		}
		this.notify();
	}

	private notify() {
		this.onChange(
			this.active?.action ?? null,
			this.pending.map((entry) => entry.action)
		);
	}
}
