import type { Composer } from 'vue-i18n'

declare module '@vue/runtime-core' {
	interface ComponentCustomProperties {
		$t: Composer['t']
		$rt: Composer['rt']
		$te: Composer['te']
		$d: Composer['d']
		$n: Composer['n']
		$tm: Composer['tm']
	}
}
