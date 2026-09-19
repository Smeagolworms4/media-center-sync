/// <reference types="vite/client" />

interface ImportMetaEnv {
	/**
	 * Origin of the API, without a trailing slash.
	 *
	 * Empty — the default — makes every call relative, which is what the single
	 * container and the dev proxy both serve.
	 */
	readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
