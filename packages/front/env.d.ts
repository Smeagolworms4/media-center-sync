/// <reference types="vite/client" />

interface ImportMetaEnv {
	/**
	 * Origin of the API, without a trailing slash.
	 *
	 * Empty — the default — makes every call relative, which is what the single
	 * container and the dev proxy both serve.
	 */
	readonly VITE_API_BASE_URL?: string;
	/**
	 * What this bundle was built from, printed in the console on load.
	 *
	 * Set by the image at build time from the tag being released. Absent in development,
	 * which is the honest answer there: nothing has been released.
	 */
	readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
