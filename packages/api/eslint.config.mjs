import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat config for the API package.
 *
 * Type-aware rules are deliberately left out: they need a full program per lint run,
 * which on this package costs more than the whole test suite, and `tsc --noEmit`
 * already answers every question they would.
 */
export default tseslint.config(
	{
		ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				ecmaVersion: 2023,
				sourceType: 'module',
			},
		},
		rules: {
			indent: ['error', 'tab', { SwitchCase: 1 }],
			quotes: ['error', 'single', { avoidEscape: true }],
			semi: ['error', 'always'],
			'comma-dangle': ['error', 'always-multiline'],
			'eol-last': ['error', 'always'],
			// Decorator metadata needs the parameter to exist even when nothing reads
			// it, so an unused argument is only a mistake when it is not marked.
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/explicit-member-accessibility': [
				'error',
				{ accessibility: 'explicit', overrides: { constructors: 'explicit' } },
			],
		},
	},
	{
		// The entities and the migration describe a schema; their long literal objects
		// are data, and wrapping them to a column width would only make them harder to
		// compare with what the database holds.
		files: ['src/database/migrations/**/*.ts'],
		rules: {
			'@typescript-eslint/no-unsafe-assignment': 'off',
		},
	},
);
