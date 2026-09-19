import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { VForm, VTextField } from 'vuetify/components';
import { useForm } from '@/composables/useForm';
import { useValidators } from '@/plugins/validators';
import { mountWithApp } from './helpers';

interface HarnessProps {
	handle: () => Promise<void> | void;
	fallbackError?: string;
}

/** A two-field form written the way `pages/Login.vue` writes one. */
const Harness = defineComponent({
	props: {
		handle: { type: Function, required: true },
		fallbackError: { type: String, default: undefined },
	},
	setup (props) {
		const validators = useValidators();
		const username = ref('');
		const password = ref('');
		const form = useForm({
			fallbackError: props.fallbackError,
			fields: {
				username: { rules: [validators.required()] },
				password: { rules: [validators.required()] },
			},
			handle: () => (props.handle as () => Promise<void>)(),
		});

		return { form, username, password };
	},
	render () {
		return h(VForm, { onVnodeMounted: undefined }, {
			default: () => [
				h(VTextField, { modelValue: this.username, 'onUpdate:modelValue': (v: string) => { this.username = v; }, ...this.form.field('username') }),
				h(VTextField, { modelValue: this.password, 'onUpdate:modelValue': (v: string) => { this.password = v; }, ...this.form.field('password') }),
			],
		});
	},
});

function mountForm (props: HarnessProps) {
	const { wrapper } = mountWithApp<any>(Harness, { props });
	// The directive is what normally wires this up; the harness renders the VForm
	// itself, so the reference is handed over the same way by hand.
	wrapper.vm.form.component = wrapper.findComponent(VForm).vm;
	return wrapper;
}

async function flush (): Promise<void> {
	await nextTick();
	await new Promise(resolve => { setTimeout(resolve, 0); });
	await nextTick();
}

function errorResponse (body: unknown, status = 400): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('useForm', () => {
	it('does not run the handler while a rule refuses', async () => {
		const handle = vi.fn();
		const wrapper = mountForm({ handle });

		await wrapper.vm.form.handle();
		await flush();

		expect(handle).not.toHaveBeenCalled();
		expect(wrapper.vm.form.field('username')['error-messages']).toEqual([]);
	});

	it('runs the handler once every rule passes', async () => {
		const handle = vi.fn();
		const wrapper = mountForm({ handle });
		wrapper.vm.username = 'ada';
		wrapper.vm.password = 'secret';
		await flush();

		await wrapper.vm.form.handle();

		expect(handle).toHaveBeenCalledOnce();
		expect(wrapper.vm.form.mainError).toBeNull();
	});

	it('maps backend field errors onto the fields that own them', async () => {
		const wrapper = mountForm({
			handle: () => Promise.reject(errorResponse({
				statusCode: 400,
				message: ['username is already taken', 'password is too weak'],
				error: 'Bad Request',
			})),
		});
		wrapper.vm.username = 'ada';
		wrapper.vm.password = 'secret';
		await flush();

		await wrapper.vm.form.handle();
		await flush();

		expect(wrapper.vm.form.field('username')['error-messages']).toEqual(['is already taken']);
		expect(wrapper.vm.form.field('password')['error-messages']).toEqual(['is too weak']);
		expect(wrapper.vm.form.mainError).toBeNull();
	});

	it('shows a business failure as the main error', async () => {
		const wrapper = mountForm({
			handle: () => Promise.reject(errorResponse({
				statusCode: 401,
				message: 'error.auth.invalid_credentials',
				error: 'Unauthorized',
			}, 401)),
		});
		wrapper.vm.username = 'ada';
		wrapper.vm.password = 'nope';
		await flush();

		await wrapper.vm.form.handle();
		await flush();

		expect(wrapper.vm.form.mainError).toBe('Wrong username or password.');
		expect(wrapper.vm.form.field('username')['error-messages']).toEqual([]);
	});

	it('uses the form fallback for an error it cannot translate', async () => {
		const wrapper = mountForm({
			fallbackError: 'error.auth.invalid_credentials',
			handle: () => Promise.reject(errorResponse({ statusCode: 500, message: 'error.unknown.key' }, 500)),
		});
		wrapper.vm.username = 'ada';
		wrapper.vm.password = 'x';
		await flush();

		await wrapper.vm.form.handle();
		await flush();

		expect(wrapper.vm.form.mainError).toBe('Wrong username or password.');
	});

	it('holds the loading flag for as long as the handler runs', async () => {
		let release!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		const wrapper = mountForm({ handle: () => pending });
		wrapper.vm.username = 'ada';
		wrapper.vm.password = 'secret';
		await flush();

		const running = wrapper.vm.form.handle();
		await flush();
		expect(wrapper.vm.form.loading).toBe(true);

		release();
		await running;
		expect(wrapper.vm.form.loading).toBe(false);
	});

	it('clears previous errors when the form is submitted again', async () => {
		let fail = true;
		const wrapper = mountForm({
			handle: () => {
				if (fail) {
					return Promise.reject(errorResponse({ statusCode: 400, message: ['username is already taken'] }));
				}
				return Promise.resolve();
			},
		});
		wrapper.vm.username = 'ada';
		wrapper.vm.password = 'secret';
		await flush();

		await wrapper.vm.form.handle();
		await flush();
		expect(wrapper.vm.form.field('username')['error-messages']).toHaveLength(1);

		fail = false;
		await wrapper.vm.form.handle();
		await flush();
		expect(wrapper.vm.form.field('username')['error-messages']).toEqual([]);
	});

	it('accepts errors pushed in by the caller', async () => {
		const wrapper = mountForm({ handle: vi.fn() });

		wrapper.vm.form.setFieldErrors({ username: ['this gateway already knows that name'] });
		await flush();

		expect(wrapper.vm.form.field('username')['error-messages'])
			.toEqual(['this gateway already knows that name']);
	});
});
