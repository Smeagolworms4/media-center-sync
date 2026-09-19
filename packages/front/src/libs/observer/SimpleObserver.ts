import { Subscription } from './Subscription';

export class SimpleObserver {
	private _count = 0;
	private _subscribes: Record<number, (...args: any[]) => any> = {};

	public subscribe (callback: (...args: any[]) => any): Subscription {
		const id = ++this._count;
		this._subscribes[id] = callback;
		return new Subscription(id, () => delete this._subscribes[id]);
	}

	public async trigger (...args: any[]): Promise<void> {
		try {
			await Promise.all(
				Object.values(this._subscribes).map(callback => callback(...args)),
			);
		} catch (error) {
			console.error(error);
		}
	}
}
