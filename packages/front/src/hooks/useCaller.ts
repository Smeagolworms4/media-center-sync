import type { Caller } from '@/libs/caller';
import { getCaller } from '@/libs/caller';
import { usePinia } from '@/hooks/useCommonContext';

/**
 * Access to the named callers from a store or a component.
 *
 *   const { caller } = useCaller();
 *   const services = await caller('api').get<MediaService[]>('/services');
 *
 * Callers are resolved against the active pinia rather than imported directly,
 * because a caller needs the session and the locale, and those live in stores.
 */
export function useCaller() {
	const pinia = usePinia();
	const caller = (name: string): Caller => getCaller(name, pinia);
	return { caller };
}
