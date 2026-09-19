import { useApp } from '@/hooks';

export function useIsGranted(): (rights: string|string[]) => boolean {
	const app = useApp();
	return (rights: string|string[]) => app.config.globalProperties.$isGranted(rights);
}
