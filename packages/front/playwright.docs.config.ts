import { defineConfig, devices } from '@playwright/test';

/**
 * The README's screenshots, generated rather than taken.
 *
 * A screenshot pasted into a repository is right once. This one is re-made by a
 * command, so the day a screen changes the picture of it can be brought back into
 * line without anybody hunting for the window size that was used the first time.
 *
 * Deliberately not part of `playwright.config.ts`: these write files into `docs/`,
 * which is not something a test run should do, and they need a stack with real
 * content rather than the fixtures the journeys create for themselves.
 */
/** The frame, kept in one place so the project can re-apply it over the device preset. */
const SHOT = {
	// Fixed so the pictures stay comparable between runs, and wide enough that the
	// poster wall shows a row rather than a column. Not a device preset: those change
	// with Playwright, and the README would shift with them.
	viewport: { width: 1440, height: 1180 },
	deviceScaleFactor: 2,
	locale: 'en-GB',
	colorScheme: 'dark' as const,
};

export default defineConfig({
	testDir: './tests/screenshots',
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	use: {
		baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3200',
		...SHOT,
	},
	projects: [
		{
			name: 'chromium',
			// After the preset, not before: a project's `use` overrides the top-level
			// one, and `Desktop Chrome` carries its own 1280x720 viewport at scale 1.
			// Spread first and the settings above are silently discarded — the shots
			// come out at the preset's size and nothing reports a conflict.
			use: { ...devices['Desktop Chrome'], ...SHOT },
		},
	],
});
