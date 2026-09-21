import { defineConfig, devices } from '@playwright/test';

/**
 * The journeys run against a stack that is already up — `make e2e` locally,
 * `make e2e/ci` on a runner. They never start a server themselves: a journey that
 * boots its own stack tests a stack nobody else has, and passes while the real one
 * is broken.
 *
 * Three projects, each depending on the one before, because installing the gateway is
 * itself a journey and its result is where every other one starts:
 *
 * 1. **install** — `setup.spec.ts` claims the gateway through its setup screen, as the
 *    administrator every later journey signs in as. On a gateway that is already
 *    claimed it has nothing to install, and says so.
 * 2. **data** — `data.spec.ts` proves the installed gateway is ready for what the
 *    journeys assume of it.
 * 3. **journeys** — everything else.
 *
 * Playwright's `dependencies` rather than file names that happen to sort first: a
 * failed install then stops the run with the reason, instead of letting thirty
 * journeys fail one by one on a sign-in page that has nobody to sign in.
 */
const INSTALL = /setup\.spec\.ts$/;
const DATA = /data\.spec\.ts$/;

const browser = { ...devices['Desktop Chrome'] };

export default defineConfig({
	testDir: './tests/e2e',
	// Its own directory per run when asked for one. Playwright empties this directory on
	// start, so two runs sharing the default wipe each other's traces — which is what
	// happened to `test-results/` when several ran at once.
	outputDir: process.env.E2E_OUTPUT_DIR || 'test-results',
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: process.env.CI ? [['github'], ['list']] : [['list']],
	use: {
		baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3200',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
	},
	projects: [
		{ name: 'install', testMatch: INSTALL, use: browser },
		{ name: 'data', testMatch: DATA, dependencies: ['install'], use: browser },
		{ name: 'journeys', testIgnore: [INSTALL, DATA], dependencies: ['data'], use: browser },
	],
});
