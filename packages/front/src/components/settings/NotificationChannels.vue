<script lang="ts" setup>
	import type { CreateNotificationChannelRequest, NotificationChannel } from '@mcs/shared';
	import { NotificationChannelType, NotificationEvent } from '@mcs/shared';
	import { computed, onMounted, reactive, ref } from 'vue';
	import { useI18n } from 'vue-i18n';
	import Confirm from '@/components/Confirm.vue';
	import FormMainError from '@/components/FormMainError.vue';
	import { useForm } from '@/composables/useForm';
	import { formatRelativeDate } from '@/composables/useFormat';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useValidators } from '@/plugins/validators';
	import { useNotificationChannelsStore } from '@/stores/notifications';

	/**
	 * Adding, testing and removing the ways this gateway reaches somebody.
	 *
	 * A list with a dialog rather than a block of fields on the settings form, because
	 * a channel is a row and not a setting: a household has a phone topic and a shared
	 * mailbox at once, two people want different events, and one of them silences
	 * theirs for a week. None of that fits a key/value pair.
	 *
	 * The test button is the part worth defending. A channel that fails silently is a
	 * channel nobody can trust, so pressing it sends a real message and reports what
	 * happened — including the far end's own words when it refused, which are the
	 * diagnosis no wording of ours could carry.
	 */
	const { locale, t } = useI18n();
	const store = useNotificationChannelsStore();
	const validators = useValidators();
	const { notify } = useNotifier();

	/** What kind of control a setting takes, and whether it may be left empty. */
	interface ConfigField {
		name: string;
		control: 'text' | 'number' | 'boolean' | 'secret';
		required?: boolean;
	}

	/**
	 * The settings each kind of channel asks for, declared rather than branched on.
	 *
	 * The API refuses what a handler cannot use and names the field, so this table is
	 * only about which boxes to draw. It is not a second copy of the rules and must
	 * never become one — adding a third kind of channel is a line here and a class in
	 * the API, which is the whole reason the contract keeps `config` opaque.
	 */
	const FIELDS: Record<NotificationChannelType, ConfigField[]> = {
		[NotificationChannelType.NTFY]: [
			{ name: 'url', control: 'text', required: true },
			{ name: 'topic', control: 'text', required: true },
			{ name: 'token', control: 'secret' },
		],
		[NotificationChannelType.SMTP]: [
			{ name: 'host', control: 'text', required: true },
			{ name: 'port', control: 'number' },
			{ name: 'secure', control: 'boolean' },
			{ name: 'username', control: 'text' },
			{ name: 'password', control: 'secret' },
			{ name: 'from', control: 'text', required: true },
			{ name: 'to', control: 'text', required: true },
		],
	};

	const EVENTS = Object.values(NotificationEvent);

	const dialog = ref(false);
	const editing = ref<NotificationChannel | null>(null);
	const testing = ref<string | null>(null);
	const removing = ref<NotificationChannel | null>(null);
	const removingBusy = ref(false);

	const model = reactive({
		name: '',
		type: NotificationChannelType.NTFY,
		enabled: true,
		events: [] as NotificationEvent[],
		config: {} as Record<string, unknown>,
	});

	/**
	 * Secrets somebody has asked to remove.
	 *
	 * An empty box means "leave what is stored alone" — the API reads an absent key
	 * that way, and that is the only thing that makes renaming a channel possible
	 * without retyping its token. It leaves no way to say "there is no token any
	 * more", so that gets its own tick box; without one, clearing a credential would
	 * mean deleting the channel and building it again.
	 */
	const cleared = ref<string[]>([]);

	const fields = computed(() => FIELDS[model.type] ?? []);

	const typeItems = computed(() =>
		Object.values(NotificationChannelType).map(value => ({
			value,
			title: t(`notification.kind.${value}`),
			subtitle: t(`notification.kind_help.${value}`),
		})),
	);

	function fieldValue (name: string): string {
		const value = model.config[name];

		return value === undefined || value === null ? '' : String(value);
	}

	function setFieldValue (name: string, value: unknown): void {
		model.config[name] = value;
	}

	function isCleared (name: string): boolean {
		return cleared.value.includes(name);
	}

	function setCleared (name: string, value: boolean): void {
		cleared.value = value
			? [...cleared.value, name]
			: cleared.value.filter(one => one !== name);
	}

	function open (channel: NotificationChannel | null): void {
		editing.value = channel;
		cleared.value = [];
		model.name = channel?.name ?? '';
		model.type = channel?.type ?? NotificationChannelType.NTFY;
		model.enabled = channel?.enabled ?? true;
		model.events = [...(channel?.events ?? [])];
		// Copied rather than referenced: the store's row is what the list renders, and
		// sharing the object would make an abandoned edit look saved everywhere else.
		model.config = { ...channel?.config };
		dialog.value = true;
	}

	/**
	 * The settings as the API should receive them.
	 *
	 * A secret left empty is left out so the stored one survives; one explicitly
	 * cleared is sent as an empty string, which is how the API spells "remove it".
	 */
	function config (): Record<string, unknown> {
		const out: Record<string, unknown> = {};

		for (const field of fields.value) {
			const value = model.config[field.name];

			if (field.control === 'secret') {
				if (isCleared(field.name)) {
					out[field.name] = '';
				} else if (typeof value === 'string' && value !== '') {
					out[field.name] = value;
				}

				continue;
			}

			if (value !== undefined && value !== null && value !== '') {
				out[field.name] = field.control === 'number' ? Number(value) : value;
			}
		}

		return out;
	}

	function request (): CreateNotificationChannelRequest {
		return {
			name: model.name,
			type: model.type,
			enabled: model.enabled,
			events: model.events,
			config: config(),
		};
	}

	const form = useForm({
		fallbackError: 'error.notification.config_invalid',
		fields: computed(() => ({
			name: { rules: [validators.required(), validators.maxlength({ max: 120 })] },
			type: { rules: [validators.required()] },
			...Object.fromEntries(
				fields.value.map(field => [
					field.name,
					// Only the boxes this kind of channel cannot work without. The API
					// refuses the rest by name, and a second copy of its rules here would
					// be two answers to disagree the day a handler changes one.
					{ rules: field.required ? [validators.required()] : [] },
				]),
			),
		})),
		handle: async () => {
			await (editing.value
				? store.update(editing.value.id, request())
				: store.create(request()));

			dialog.value = false;
			await notify('settings.saved');
		},
	});

	/**
	 * A failed load leaves the section empty rather than refusing the page.
	 *
	 * This block sits inside the settings screen, which somebody may well have opened
	 * to change something else entirely; a gateway that cannot list its channels must
	 * not take the rest of the form down with it.
	 */
	onMounted(() => {
		void store.load().catch(() => undefined);
	});

	function sentAt (channel: NotificationChannel): string {
		return t('notification.last_sent', {
			when: formatRelativeDate(channel.lastSentAt, locale.value) ?? '',
		});
	}

	async function test (channel: NotificationChannel): Promise<void> {
		testing.value = channel.id;
		try {
			const result = await store.test(channel.id);

			await (result.delivered
				? notify('notification.test_ok')
				: notify(t('notification.test_failed', { reason: result.error ?? '' }), 'error'));
		} catch {
			await notify('error.notification.send_failed', 'error');
		} finally {
			testing.value = null;
		}
	}

	async function confirmRemove (): Promise<void> {
		if (!removing.value) {
			return;
		}

		removingBusy.value = true;
		try {
			await store.remove(removing.value.id);
			removing.value = null;
		} catch {
			await notify('error.general', 'error');
		} finally {
			removingBusy.value = false;
		}
	}
</script>

<template>
	<div class="notification-channels" data-test="notification-channels">
		<p class="text-body-2 text-medium-emphasis mb-3">{{ $t('notification.help') }}</p>

		<v-progress-linear v-if="store.loading && !store.loaded" color="primary" indeterminate />

		<p
			v-else-if="store.channels.length === 0"
			class="text-body-2 text-medium-emphasis"
			data-test="notification-empty"
		>
			{{ $t('notification.empty') }}
		</p>

		<v-list v-else class="notification-channels_list" density="compact">
			<v-list-item
				v-for="channel of store.channels"
				:key="channel.id"
				:data-test="`notification-channel-${channel.id}`"
				lines="two"
			>
				<v-list-item-title>
					{{ channel.name }}

					<v-chip class="ml-2" label size="x-small" variant="tonal">
						{{ $t(`notification.kind.${channel.type}`) }}
					</v-chip>

					<v-chip
						v-if="!channel.enabled"
						class="ml-1"
						data-test="notification-disabled"
						label
						size="x-small"
						variant="tonal"
					>
						{{ $t('common.no') }}
					</v-chip>
				</v-list-item-title>

				<!--
					The failure is on the row and not only in the toast that appeared for
					four seconds while somebody was pressing test. A channel that has
					delivered nothing since March has to be visible as such.
				-->
				<v-list-item-subtitle>
					<span
						v-if="channel.lastError"
						class="text-error"
						data-test="notification-last-error"
					>
						{{ $t('notification.last_error', { reason: channel.lastError }) }}
					</span>

					<span v-else-if="channel.lastSentAt" data-test="notification-last-sent">
						{{ sentAt(channel) }}
					</span>

					<span v-else data-test="notification-never-sent">
						{{ $t('notification.never_sent') }}
					</span>
				</v-list-item-subtitle>

				<template #append>
					<v-btn
						:data-test="`notification-test-${channel.id}`"
						:loading="testing === channel.id"
						size="small"
						variant="text"
						@click="test(channel)"
					>
						{{ $t('notification.test') }}
					</v-btn>

					<v-btn
						:data-test="`notification-edit-${channel.id}`"
						icon="mdi-pencil-outline"
						size="small"
						:title="$t('notification.edit')"
						variant="text"
						@click="open(channel)"
					/>

					<v-btn
						:data-test="`notification-remove-${channel.id}`"
						icon="mdi-delete-outline"
						size="small"
						:title="$t('notification.remove')"
						variant="text"
						@click="removing = channel"
					/>
				</template>
			</v-list-item>
		</v-list>

		<v-btn
			class="mt-2"
			data-test="notification-add"
			prepend-icon="mdi-plus"
			variant="tonal"
			@click="open(null)"
		>
			{{ $t('notification.add') }}
		</v-btn>

		<v-dialog v-model="dialog" data-test="notification-dialog" max-width="640">
			<v-card>
				<v-card-title class="text-subtitle-1">{{ $t('notification.title') }}</v-card-title>

				<v-card-text>
					<v-form v-form="form" data-test="notification-form">
						<FormMainError :form="form" />

						<v-text-field
							v-model="model.name"
							v-bind="form.field('name')"
							data-test="notification-name"
							:hint="$t('notification.name_help')"
							:label="$t('notification.name')"
							persistent-hint
						/>

						<v-select
							v-model="model.type"
							v-bind="form.field('type')"
							class="mt-4"
							data-test="notification-type"
							item-props
							item-title="title"
							item-value="value"
							:items="typeItems"
							:label="$t('notification.type')"
						/>

						<template v-for="field of fields" :key="field.name">
							<v-switch
								v-if="field.control === 'boolean'"
								v-bind="form.field(field.name)"
								class="mt-2"
								color="primary"
								:data-test="`notification-config-${field.name}`"
								density="compact"
								:hint="$t(`notification.field_help.${field.name}`)"
								:label="$t(`notification.field.${field.name}`)"
								:model-value="model.config[field.name] === true"
								persistent-hint
								@update:model-value="value => setFieldValue(field.name, value === true)"
							/>

							<div v-else-if="field.control === 'secret'" class="mt-4">
								<v-text-field
									v-bind="form.field(field.name)"
									:data-test="`notification-config-${field.name}`"
									:disabled="isCleared(field.name)"
									:hint="editing ? $t('notification.secret_kept') : $t(`notification.field_help.${field.name}`)"
									:label="$t(`notification.field.${field.name}`)"
									:model-value="fieldValue(field.name)"
									persistent-hint
									type="password"
									@update:model-value="value => setFieldValue(field.name, value)"
								/>

								<v-checkbox
									v-if="editing"
									:data-test="`notification-clear-${field.name}`"
									density="compact"
									hide-details
									:label="$t('notification.secret_clear')"
									:model-value="isCleared(field.name)"
									@update:model-value="value => setCleared(field.name, value === true)"
								/>
							</div>

							<v-text-field
								v-else
								v-bind="form.field(field.name)"
								class="mt-4"
								:data-test="`notification-config-${field.name}`"
								:hint="$t(`notification.field_help.${field.name}`)"
								:label="$t(`notification.field.${field.name}`)"
								:model-value="fieldValue(field.name)"
								persistent-hint
								:type="field.control === 'number' ? 'number' : 'text'"
								@update:model-value="value => setFieldValue(field.name, value)"
							/>
						</template>

						<v-switch
							v-model="model.enabled"
							class="mt-4"
							color="primary"
							data-test="notification-enabled"
							density="compact"
							:hint="$t('notification.enabled_help')"
							:label="$t('notification.enabled')"
							persistent-hint
						/>

						<p class="text-body-2 font-weight-medium mt-4 mb-0">
							{{ $t('notification.events') }}
						</p>

						<p class="text-caption text-medium-emphasis mb-1">
							{{ $t('notification.events_all') }}
						</p>

						<v-checkbox
							v-for="event of EVENTS"
							:key="event"
							v-model="model.events"
							:data-test="`notification-event-${event}`"
							density="compact"
							hide-details
							:label="$t(`notification.event.${event}`)"
							:value="event"
						/>
					</v-form>
				</v-card-text>

				<v-card-actions>
					<v-spacer />

					<v-btn data-test="notification-cancel" variant="text" @click="dialog = false">
						{{ $t('actions.cancel') }}
					</v-btn>

					<v-btn
						color="primary"
						data-test="notification-save"
						:loading="form.loading"
						variant="flat"
						@click="form.handle()"
					>
						{{ $t('actions.save') }}
					</v-btn>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<Confirm
			:loading="removingBusy"
			:model-value="removing !== null"
			:text="$t('notification.remove_confirm', { name: removing?.name ?? '' })"
			:title="$t('notification.remove')"
			@cancel="removing = null"
			@confirm="confirmRemove"
		/>
	</div>
</template>

<style lang="scss" scoped>
	.notification-channels {
		&_list {
			background: transparent;
		}
	}
</style>
