import vuetify from 'eslint-config-vuetify';

export default vuetify({
	rules: {
		// Tabs everywhere, like the rest of the repository.
		'@stylistic/indent': ['error', 'tab'],
		'@stylistic/no-tabs': 'off',
		'vue/html-indent': ['error', 'tab'],
		'vue/script-indent': ['error', 'tab', { baseIndent: 1 }],
	},
	ignores: ['dist/**', 'coverage/**', 'test-results/**', 'playwright-report/**'],
});
