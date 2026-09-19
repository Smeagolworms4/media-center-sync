import type { Right } from '@mcs/shared';
import 'vue-router';

declare module 'vue-router' {
	interface RouteMeta {
		/** Reachable without a session. */
		publicPage?: boolean;
		/** Reserved for visitors without a session, such as the sign-in page. */
		disconnectPage?: boolean;
		/** i18n key of the page title. */
		title?: string;
		/** Rights the viewer must hold, all of them, to reach this route. */
		granted?: Right[];
		/** Icon shown next to this entry in the navigation drawer. */
		icon?: string;
		/** Shown in the navigation drawer when true. */
		nav?: boolean;
	}
}
