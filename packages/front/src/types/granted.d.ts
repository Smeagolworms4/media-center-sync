import '@vue/runtime-core';

declare module '@vue/runtime-core' {
	export interface ComponentCustomProperties {
		$isGranted: (rights: string|string[]) => boolean;
		$routeGranted: (routeName: string) => boolean;
	}
}
