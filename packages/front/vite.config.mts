import { fileURLToPath, URL } from 'node:url';
import Vue from '@vitejs/plugin-vue';
import Fonts from 'unplugin-fonts/vite';
import { defineConfig, loadEnv } from 'vite';
import Vuetify, { transformAssetUrls } from 'vite-plugin-vuetify';

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '');
	// The API the dev server relays `/api` to. In the container it is the sibling
	// service; on the host it is whatever you point it at.
	const apiProxyTarget = env.API_PROXY_TARGET || 'http://localhost:4200';
	const devPort = Number(env.FRONT_PORT) || 3200;

	return {
		plugins: [
			Vue({ template: { transformAssetUrls } }),
			Vuetify({
				autoImport: true,
				styles: { configFile: 'src/styles/settings.scss' },
			}),
			Fonts({
				fontsource: {
					families: [
						{
							name: 'Roboto',
							weights: [100, 300, 400, 500, 700, 900],
							styles: ['normal', 'italic'],
						},
					],
				},
			}),
		],
		define: { 'process.env': {} },
		resolve: {
			alias: {
				'@': fileURLToPath(new URL('src', import.meta.url)),
			},
			extensions: ['.js', '.json', '.jsx', '.mjs', '.ts', '.tsx', '.vue'],
		},
		css: {
			preprocessorOptions: {
				scss: { additionalData: '@use "@/styles/variables" as *;\n' },
			},
		},
		server: {
			port: devPort,
			host: '0.0.0.0',
			proxy: {
				// The API is served on the same origin as the interface, which removes
				// CORS from the picture entirely: the client calls relative `/api/...`
				// paths and Vite relays them. Production does the same, from one image.
				'/api': {
					target: apiProxyTarget,
					changeOrigin: true,
					// The progress stream is a WebSocket on the same prefix. Without
					// this it is refused silently and the bars stay at zero while the
					// files do arrive.
					ws: true,
				},
			},
		},
		test: {
			environment: 'jsdom',
			globals: true,
			setupFiles: ['./tests/unit/setup.ts'],
			include: ['src/**/*.spec.ts', 'tests/unit/**/*.spec.ts'],
			coverage: {
				provider: 'v8',
				reporter: ['text', 'lcov', 'cobertura'],
				include: ['src/**/*.{ts,vue}'],
				exclude: ['src/**/index.ts', 'src/main.ts', 'src/plugins/**'],
				thresholds: { statements: 75, branches: 65, functions: 75, lines: 75 },
			},
			reporters: ['default', ['junit', { outputFile: 'junit.xml' }]],
		},
	};
});
