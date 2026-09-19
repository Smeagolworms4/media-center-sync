import type { Right } from '@mcs/shared';
import '@vue/runtime-core';

declare module '@vue/runtime-core' {
	export interface ComponentCustomProperties {
		$isGranted: (rights: Right | Right[]) => boolean;
		$routeGranted: (routeName: string) => boolean;
	}
}
