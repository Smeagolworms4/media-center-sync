const globalCtx: any = {};

export function cachePromise<T> (
	callback: (...args: any[]) => Promise<T>,
	clearAfterCall = false,
	context: Nullable<any> = null,
): (key: string | number, ...args: any[]) => Promise<T> {
	if (context && !(context as any).__cachePomise__) {
		(context as any).__cachePomise__ = {};
	}
	const cache: any = (context as any)?.__cachePomise__ ?? globalCtx;
	return (key: string | number, ...args: any[]): Promise<T> => {
		if (!cache[key]) {
			cache[key] = (async () => {
				try {
					return await callback(...args);
				} finally {
					if (clearAfterCall) {
						delete cache[key];
					}
				}
			})();
		}
		return cache[key];
	};
}
