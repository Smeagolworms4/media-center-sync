export class Subscription {
	public constructor(
		public readonly id: number,
		private _unsubscribe: () => void,
	) {
	}

	public unsubscribe(): void {
		this._unsubscribe()
	}
}
