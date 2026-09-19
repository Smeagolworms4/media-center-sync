/**
 * Debounced version of an async function.
 *
 * Only the last call inside the delay window actually runs, but every caller
 * still gets a promise — they all resolve with that one result. Callers that
 * were dropped therefore never hang, which is what makes this safe to put behind
 * a search field.
 */
export function useDebounce<Args extends any[], R>(
	fn: (...args: Args) => Promise<R>,
	delay: number,
): (...args: Args) => Promise<R> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pendingResolves: ((value: R) => void)[] = [];
	let pendingRejects: ((reason: any) => void)[] = [];

	return (...args: Args): Promise<R> => {
		return new Promise<R>((resolve, reject) => {
			pendingResolves.push(resolve);
			pendingRejects.push(reject);

			if (timer) {
				clearTimeout(timer);
			}

			timer = setTimeout(async () => {
				const resolves = pendingResolves;
				const rejects = pendingRejects;
				pendingResolves = [];
				pendingRejects = [];
				timer = null;

				try {
					const result = await fn(...args);
					resolves.forEach(r => r(result));
				} catch (e) {
					rejects.forEach(r => r(e));
				}
			}, delay);
		});
	};
}
