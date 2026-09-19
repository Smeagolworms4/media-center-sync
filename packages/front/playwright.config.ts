import { defineConfig, devices } from '@playwright/test';

/**
 * The journeys run against a stack that is already up — `make e2e` locally,
 * `make e2e/ci` on a runner. They never start a server themselves: a journey that
 * boots its own stack tests a stack nobody else has, and passes while the real one
 * is broken.
 */
export default defineConfig({
	testDir: './tests/e2e',
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
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
