import type { CommandEntry } from './history';

export type PinnedCommand = Pick<CommandEntry, 'text' | 'cwd' | 'createdAt'> & {
	pinnedAt: number;
};
type PinRecord = Pick<CommandEntry, 'text' | 'cwd' | 'createdAt'>;

/** Favorites contain the command itself, independently of IndexedDB history records. */
export class CommandPins {
	readonly key: string;
	constructor(
		scope: string,
		private storage: Pick<Storage, 'getItem' | 'setItem'>
	) {
		this.key = `compose-shell-command-pins-v1:${scope}`;
	}
	list(): PinnedCommand[] {
		const stored = this.storage.getItem(this.key);
		if (!stored) return [];
		const value: unknown = JSON.parse(stored);
		if (!Array.isArray(value)) throw new Error('Invalid saved commands.');
		const seen = new Set<string>();
		return value
			.filter((entry): entry is PinnedCommand => {
				if (!entry || typeof entry !== 'object') return false;
				const pin = entry as Partial<PinnedCommand>;
				if (
					typeof pin.text !== 'string' ||
					!pin.text.trim() ||
					typeof pin.cwd !== 'string' ||
					!validTime(pin.createdAt) ||
					!validTime(pin.pinnedAt) ||
					seen.has(pin.text)
				)
					return false;
				seen.add(pin.text);
				return true;
			})
			.map(({ text, cwd, createdAt, pinnedAt }) => ({ text, cwd, createdAt, pinnedAt }));
	}
	toggle(record: PinRecord): PinnedCommand[] {
		// Read at mutation time so another tab's changes are not overwritten by a stale UI list.
		const current = this.list();
		const exists = current.some((pin) => pin.text === record.text);
		const next = exists
			? current.filter((pin) => pin.text !== record.text)
			: [
					{ text: record.text, cwd: record.cwd, createdAt: record.createdAt, pinnedAt: Date.now() },
					...current
				];
		this.storage.setItem(this.key, JSON.stringify(next));
		return next;
	}
}

function validTime(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
}
