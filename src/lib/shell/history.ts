import { shellApiBase, type ShellLaunch } from './launch';

export type CommandEntry = {
	id: number;
	scope: string;
	text: string;
	cwd: string;
	sessionId: string;
	createdAt: number;
};
export type CommandRecord = Pick<CommandEntry, 'text' | 'cwd' | 'sessionId'>;

export function commandHistoryScope(
	launch: ShellLaunch,
	backend: 'live' | 'demo',
	origin: string
): string {
	const target = launch.target;
	return JSON.stringify([
		shellApiBase(launch, origin),
		backend,
		target.kind === 'vm'
			? ['vm']
			: [target.kind, target.project, target.service, target.containerId ?? '', target.path]
	]);
}

/** One record per submission. No pruning or count cap; reads use indexed cursor pages. */
export class CommandHistory {
	private database?: Promise<IDBDatabase>;
	private closed = false;
	constructor(
		private scope: string,
		private factory: IDBFactory = indexedDB
	) {}
	private open(): Promise<IDBDatabase> {
		if (this.closed) return Promise.reject(new Error('Command history is closed.'));
		return (this.database ??= new Promise((resolve, reject) => {
			const request = this.factory.open('compose-shell-command-history', 1);
			request.onupgradeneeded = () => {
				const store = request.result.createObjectStore('commands', {
					keyPath: 'id',
					autoIncrement: true
				});
				store.createIndex('scope-id', ['scope', 'id'], { unique: true });
			};
			request.onerror = () => reject(request.error);
			request.onblocked = () => reject(new Error('Another tab is blocking command history.'));
			request.onsuccess = () => {
				const database = request.result;
				database.onversionchange = () => {
					database.close();
					this.database = undefined;
				};
				if (this.closed) database.close();
				resolve(database);
			};
		}));
	}
	async append(record: CommandRecord): Promise<void> {
		const database = await this.open();
		return new Promise((resolve, reject) => {
			const transaction = database.transaction('commands', 'readwrite');
			transaction.objectStore('commands').add({
				...record,
				scope: this.scope,
				createdAt: Date.now()
			});
			transaction.oncomplete = () => resolve();
			transaction.onabort = () => reject(transaction.error);
			transaction.onerror = () => reject(transaction.error);
		});
	}
	async page(before?: number, limit = 40): Promise<CommandEntry[]> {
		return this.read('prev', before, limit);
	}
	async neighbor(
		id: number | undefined,
		direction: 'older' | 'newer'
	): Promise<CommandEntry | null> {
		return (await this.read(direction === 'older' ? 'prev' : 'next', id, 1))[0] ?? null;
	}
	private async read(
		direction: IDBCursorDirection,
		id: number | undefined,
		limit: number
	): Promise<CommandEntry[]> {
		const database = await this.open();
		const older = direction === 'prev';
		const range = IDBKeyRange.bound(
			[this.scope, !older && id !== undefined ? id : 0],
			[this.scope, older && id !== undefined ? id : Number.MAX_SAFE_INTEGER],
			!older && id !== undefined,
			older && id !== undefined
		);
		return new Promise((resolve, reject) => {
			const transaction = database.transaction('commands', 'readonly');
			const request = transaction
				.objectStore('commands')
				.index('scope-id')
				.openCursor(range, direction);
			const entries: CommandEntry[] = [];
			request.onsuccess = () => {
				const cursor = request.result;
				if (cursor && entries.length < limit) {
					entries.push(cursor.value as CommandEntry);
					if (entries.length < limit) cursor.continue();
				}
			};
			transaction.oncomplete = () => resolve(entries);
			transaction.onabort = () => reject(transaction.error);
			transaction.onerror = () => reject(transaction.error);
		});
	}
	close() {
		this.closed = true;
		void this.database?.then(
			(database) => database.close(),
			() => {}
		);
	}
}
