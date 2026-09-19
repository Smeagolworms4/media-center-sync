import 'vue-router'

declare module 'vue-router' {
	interface RouteMeta {
		/** Page accessible sans authentification */
		publicPage?: boolean
		/** Page réservée aux utilisateurs non connectés (login) */
		disconnectPage?: boolean
		/** Titre de la page */
		title?: string
		/** Rights requis pour accéder à la page */
		granted?: string[]
	}
}
