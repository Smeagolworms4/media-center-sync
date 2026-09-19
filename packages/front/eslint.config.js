import vuetify from 'eslint-config-vuetify';

/**
 * The preset's own style is two spaces and no semicolons; this repository is tabs
 * and semicolons. The overrides live in configuration objects appended after the
 * preset rather than in its options, because a rule has to sit in a configuration
 * that has the plugin it belongs to in scope.
 */
export default vuetify(
	{},
	{
		rules: {
			'@stylistic/indent': ['error', 'tab'],
			'@stylistic/no-tabs': 'off',
			'@stylistic/semi': ['error', 'always'],
			'@stylistic/member-delimiter-style': ['error', {
				multiline: { delimiter: 'semi', requireLast: true },
				singleline: { delimiter: 'semi', requireLast: false },
			}],
			// The validator plugin binds `this` to a translation proxy, and the option
			// stores use `this` as Pinia intends. Both are deliberate, and neither is
			// what this rule is looking for.
			'unicorn/no-this-outside-of-class': 'off',
		},
	},
	{
		files: ['**/*.vue'],
		rules: {
			// `vue/script-indent` owns indentation inside a single-file component; the
			// core rule fights it line for line if both are on.
			'@stylistic/indent': 'off',
			'vue/html-indent': ['error', 'tab'],
			'vue/script-indent': ['error', 'tab', { baseIndent: 1 }],
		},
	},
	{
		ignores: ['dist/**', 'coverage/**', 'test-results/**', 'playwright-report/**'],
	},
);
