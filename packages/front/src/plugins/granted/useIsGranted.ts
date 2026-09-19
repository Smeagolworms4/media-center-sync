import type { Right } from '@mcs/shared';
import { useApp } from '@/hooks/useCommonContext';

/** `isGranted` for a `<script setup>` block; the template uses `$isGranted`. */
export function useIsGranted (): (rights: Right | Right[]) => boolean {
	const app = useApp();
	return (rights: Right | Right[]) => app.config.globalProperties.$isGranted(rights);
}
