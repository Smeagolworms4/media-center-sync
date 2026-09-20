import type { NotificationChannel } from '@mcs/shared';
import { NotificationChannelType, NotificationEvent } from '@mcs/shared';
import { flushPromises } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import NotificationChannels from '@/components/settings/NotificationChannels.vue';
import { useNotificationChannelsStore } from '@/stores/notifications';
import { dialogStub, mountWithApp, stubFetchRoutes } from './helpers';

/**
 * The section that decides whether anybody ever hears from this gateway.
 *
 * Two things are asserted here above everything else. A channel that has never
 * delivered, and a channel whose last attempt failed, must both be legible on the row
 * — a silent channel nobody can see is silent has to be the thing this screen makes
 * impossible, not the thing it reproduces. And a secret is never typed twice: an
 * empty credential box means "keep what is stored", so the payload leaves the key out
 * rather than sending an empty one that would clear it.
 */
function channel (overrides: Partial<NotificationChannel> = {}): NotificationChannel {
	return {
		id: 'c1',
		type: NotificationChannelType.NTFY,
		name: 'Phones',
		enabled: true,
		events: [],
		config: { url: 'https://ntfy.sh', topic: 'loft' },
		lastError: null,
		lastSentAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function mountSection (channels: NotificationChannel[] = []) {
	const fetchStub = stubFetchRoutes({
		'/notifications/channels': { status: 200, body: channels },
	});

	return { ...mountWithApp(NotificationChannels, { global: { stubs: { ...dialogStub } } }), fetchStub };
}

/** The body of the last call that carried one, parsed. */
function lastBody (fetchStub: { mock: { calls: any[][] } }): Record<string, any> {
	const carrying = fetchStub.mock.calls.filter(call => call[1]?.body);
	const init = carrying.at(-1)?.[1] as { body: string };

	return JSON.parse(init.body) as Record<string, any>;
}

/** The section loads its list on mount; nothing on screen is true until that lands. */
async function settle (): Promise<void> {
	await flushPromises();
	await nextTick();
}

describe('components/settings/NotificationChannels', () => {
	it('says plainly that nothing is sent anywhere when there is no channel', async () => {
		// An empty list rendering as nothing at all reads as a section that failed to
		// load, which is the opposite of the fact: nothing is configured.
		const { wrapper } = mountSection();

		await settle();

		expect(wrapper.find('[data-test="notification-empty"]').exists()).toBe(true);
	});

	it('shows a channel that has never delivered as never having delivered', async () => {
		const { wrapper } = mountSection([channel()]);

		await settle();

		expect(wrapper.find('[data-test="notification-never-sent"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="notification-last-error"]').exists()).toBe(false);
	});

	it('puts the last failure on the row, in the far end’s own words', async () => {
		// Not only in the toast that appeared for four seconds while somebody was
		// pressing test: a channel that has been failing since March has to be visible
		// as such whenever this screen is opened.
		const { wrapper } = mountSection([channel({ lastError: 'invalid access token' })]);

		await settle();

		expect(wrapper.find('[data-test="notification-last-error"]').text()).toContain(
			'invalid access token',
		);
	});

	it('marks a channel somebody switched off, rather than showing it as live', async () => {
		const { wrapper } = mountSection([channel({ enabled: false })]);

		await settle();

		expect(wrapper.find('[data-test="notification-disabled"]').exists()).toBe(true);
	});

	it('draws the boxes the chosen kind of channel needs, and only those', async () => {
		const { wrapper } = mountSection();

		await settle();
		await wrapper.find('[data-test="notification-add"]').trigger('click');
		await nextTick();

		expect(wrapper.find('[data-test="notification-config-url"]').exists()).toBe(true);
		expect(wrapper.find('[data-test="notification-config-topic"]').exists()).toBe(true);
		// An SMTP field on an ntfy channel is a box somebody would fill in and a
		// setting the handler would then refuse without ever having asked for it.
		expect(wrapper.find('[data-test="notification-config-host"]').exists()).toBe(false);
	});

	it('offers every event the gateway can report', async () => {
		const { wrapper } = mountSection();

		await settle();
		await wrapper.find('[data-test="notification-add"]').trigger('click');
		await nextTick();

		for (const event of Object.values(NotificationEvent)) {
			expect(wrapper.find(`[data-test="notification-event-${event}"]`).exists(), event).toBe(true);
		}
	});

	it('leaves an untouched credential out of the payload, so the stored one survives', async () => {
		// The API never gives a token back, so the box is always empty on an edit.
		// Sending it empty would clear the credential every time somebody renamed a
		// channel — and nothing in the response would say it had happened.
		const { wrapper } = mountSection([channel()]);

		await settle();
		await wrapper.find('[data-test="notification-edit-c1"]').trigger('click');
		await nextTick();

		const stub = stubFetchRoutes({
			'/notifications/channels/c1': { status: 200, body: channel() },
		});

		await wrapper.find('[data-test="notification-save"]').trigger('click');
		await flushPromises();

		const sent = lastBody(stub).config as Record<string, unknown>;

		expect(sent).toEqual({ url: 'https://ntfy.sh', topic: 'loft' });
		expect('token' in sent).toBe(false);
	});

	it('sends an emptied credential explicitly, which is how one is removed', async () => {
		// Without this, "there is no token any more" would be inexpressible: an empty
		// box already means "keep what is stored", so removing one would take deleting
		// the channel and building it again.
		const { wrapper } = mountSection([channel()]);

		await settle();
		await wrapper.find('[data-test="notification-edit-c1"]').trigger('click');
		await nextTick();

		const clear = wrapper.findComponent<any>('[data-test="notification-clear-token"]');

		clear.vm.$emit('update:modelValue', true);
		await nextTick();

		const stub = stubFetchRoutes({
			'/notifications/channels/c1': { status: 200, body: channel() },
		});

		await wrapper.find('[data-test="notification-save"]').trigger('click');
		await flushPromises();

		expect((lastBody(stub).config as Record<string, unknown>).token).toBe('');
	});

	it('reports a test that did not deliver instead of claiming it did', async () => {
		// A wrong topic and an unreachable server are ordinary answers, not failures of
		// the request — and a channel nobody can see failing is the whole problem.
		const { pinia } = mountSection([channel()]);

		await settle();

		stubFetchRoutes({
			'/notifications/channels/c1/test': {
				status: 200,
				body: { delivered: false, error: '403 Forbidden: invalid access token', sentAt: null },
			},
			'/notifications/channels': { status: 200, body: [channel({ lastError: '403 Forbidden' })] },
		});

		const store = useNotificationChannelsStore(pinia);
		const result = await store.test('c1');

		expect(result.delivered).toBe(false);
		expect(result.error).toContain('invalid access token');
		// And the row is reread, because the attempt wrote the failure onto it.
		expect(store.channels[0].lastError).toBe('403 Forbidden');
	});

	it('drops a removed channel from the list rather than waiting for a reload', async () => {
		const { pinia } = mountSection([channel()]);

		await settle();

		stubFetchRoutes({ '/notifications/channels/c1': { status: 204 } });

		const store = useNotificationChannelsStore(pinia);

		await store.remove('c1');

		expect(store.channels).toEqual([]);
	});

	it('renders an empty answer as an empty list, never as something that is not one', async () => {
		// An empty body parses to null, and a gateway that answers nothing must not
		// leave the section iterating over it.
		const { pinia } = mountSection();

		await settle();

		stubFetchRoutes({ '/notifications/channels': { status: 200, body: null } });

		const store = useNotificationChannelsStore(pinia);

		await store.load();

		expect(store.channels).toEqual([]);
	});
});
