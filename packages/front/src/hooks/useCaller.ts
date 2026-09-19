import { getCaller } from '@/libs/caller'
import type { Caller } from '@/libs/caller'
import { usePinia } from '@/hooks/useCommonContext';

/**
 * Composable pour accéder aux callers API dans les stores et composants.
 *
 * Usage dans un store :
 *   const { caller } = useCaller()
 *   const data = await caller('api').get('/translations/front/fr')
 *
 * Usage avec auth :
 *   const data = await caller('apiAuth').get('/users/me')
 */
export function useCaller() {
	const pinia = usePinia();
	const caller = (name: string): Caller => getCaller(name, pinia)
	return { caller }
}
