import type { App } from 'vue';
import type { I18n } from 'vue-i18n';
import validators from './validators';

export * from './hooks';

export type Validator = (v: any) => true | string;
export type Validators = typeof validators;


declare module '@vue/runtime-core' {
	export interface ComponentCustomProperties {
		$validators: Validators;
	}
}

export default {
	install(app: App, { i18n }: { i18n: I18n }) {
		Object.defineProperty(app.config.globalProperties, '$validators', {
			get(): Validators {
				const result: any = {};
				const proxy = new Proxy(this, {
					get(target: any, p: string | symbol, receiver: any): any {
						if (p === '$t') { return app.config.globalProperties.$t };
						if (p === '$tm') { return app.config.globalProperties.$tm };
						if (p === '$te') { return app.config.globalProperties.$te };
						if (Object.hasOwn(target, p)) {
							return target[p];
						}
					}
				});
				Object.entries(validators)
					.forEach(([ name, validator ]) => {
						Object.defineProperty(result, name, {
							get: () => {
								return validator.bind(proxy);
							}
						})
					})
				;
				return result;
			}
		})
	}
};
