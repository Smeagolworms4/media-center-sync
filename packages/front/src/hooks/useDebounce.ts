/**
 * Crée une version debounced d'une fonction async.
 * Seul le dernier appel dans la fenêtre de délai est réellement exécuté.
 * Tous les appels retournent une Promise qui se résout avec le résultat du dernier appel.
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
