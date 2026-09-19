<script lang="ts" setup>
	import { computed, onMounted, reactive, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import FormMainError from '@/components/FormMainError.vue';
	import { useForm } from '@/composables/useForm';
	import { formatRate } from '@/composables/useFormat';
	import { bytesToRate, RATE_PRESETS, rateToBytes, type RateUnit } from '@/composables/useRateLimit';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useValidators } from '@/plugins/validators';
	import { useSettingsStore } from '@/stores/settings';
	import { useTransfersStore } from '@/stores/transfers';

	/**
	 * The global caps, where a torrent client keeps them: in the bar that is on
	 * every screen.
	 *
	 * Throttling is something people do *while looking at something else* — the
	 * household starts a video call, somebody is browsing their library, and the
	 * answer has to be one click away rather than a page change, a scroll and a
	 * form. Putting it on the transfers page would have been the obvious home and
	 * the wrong one: that is the screen you open once the pulling is already the
	 * thing annoying you.
	 *
	 * The same button carries the live aggregate rate, which is what makes it worth
	 * the space when nothing needs changing, and shows the caps whenever one is set
	 * — a gateway throttled to two megabytes a second that looks unthrottled is a
	 * support question waiting to happen.
	 */
	const settingsStore = useSettingsStore();
	const transfersStore = useTransfersStore();
	const validators = useValidators();
	const { notify } = useNotifier();
	const { locale, t } = useI18n();

	const open = ref(false);

	const model = reactive<{
		download: number | null;
		downloadUnit: RateUnit;
		upload: number | null;
		uploadUnit: RateUnit;
	}>({
		download: null,
		downloadUnit: 'mb',
		upload: null,
		uploadUnit: 'mb',
	});

	const downloadLimit = computed(() => settingsStore.settings?.downloadRateLimit ?? 0);
	const uploadLimit = computed(() => settingsStore.settings?.uploadRateLimit ?? 0);
	const capped = computed(() => downloadLimit.value > 0 || uploadLimit.value > 0);

	const rate = computed(() => transfersStore.stats.rate);

	/*
	 * One read at boot, and the stream keeps it current afterwards: the queue
	 * pushes `queue.stats` frames, so polling here would duplicate what the socket
	 * already delivers to every open tab.
	 */
	onMounted(() => {
		void transfersStore.loadStats().catch(() => undefined);
	});

	/**
	 * The fields are filled from the settings every time the menu opens rather than
	 * once: another tab, or the settings page itself, may have moved the cap since,
	 * and a form that reopens on a stale number will happily write it back.
	 */
	function fill (): void {
		const download = bytesToRate(downloadLimit.value);
		const upload = bytesToRate(uploadLimit.value);
		model.download = download.value;
		model.downloadUnit = download.unit;
		model.upload = upload.value;
		model.uploadUnit = upload.unit;
	}

	watch(open, isOpen => {
		if (isOpen) {
			fill();
		}
	});

	const unitItems = computed(() => [
		{ value: 'kb', title: t('bandwidth.unit.kb') },
		{ value: 'mb', title: t('bandwidth.unit.mb') },
	]);

	const presets = computed(() => RATE_PRESETS.map(bytes => ({
		bytes,
		label: bytes === 0 ? t('bandwidth.no_cap') : formatRate(bytes, locale.value),
	})));

	async function apply (download: number, upload: number): Promise<void> {
		await settingsStore.save({ downloadRateLimit: download, uploadRateLimit: upload });
		void notify('bandwidth.saved');
	}

	const form = useForm({
		fallbackError: 'error.settings.invalid',
		fields: {
			download: { rules: [validators.range({ min: 0 })] },
			upload: { rules: [validators.range({ min: 0 })] },
		},
		handle: async () => {
			await apply(
				rateToBytes(model.download, model.downloadUnit),
				rateToBytes(model.upload, model.uploadUnit),
			);
			open.value = false;
		},
	});

	/**
	 * A preset is applied on the click that chooses it.
	 *
	 * This is the whole reason the control exists: "cap me at two megabytes" has to
	 * be one gesture. Filling the field and waiting for a confirmation would make it
	 * three, and the field is still there for anybody who wants an exact number.
	 */
	const applying = ref(false);

	async function choose (kind: 'download' | 'upload', bytes: number): Promise<void> {
		applying.value = true;
		try {
			await apply(
				kind === 'download' ? bytes : downloadLimit.value,
				kind === 'upload' ? bytes : uploadLimit.value,
			);
			fill();
		} catch {
			void notify('error.settings.invalid', 'error');
		} finally {
			applying.value = false;
		}
	}
</script>

<template>
	<v-menu v-model="open" :close-on-content-click="false" location="bottom end">
		<template #activator="{ props: menuProps }">
			<v-btn
				v-bind="menuProps"
				class="bandwidth"
				data-test="bandwidth-control"
				variant="text"
			>
				<v-icon class="mr-2" :icon="capped ? 'mdi-speedometer-slow' : 'mdi-speedometer'" />

				<span class="bandwidth_rate">{{ formatRate(rate, locale) }}</span>

				<span v-if="capped" class="bandwidth_caps" data-test="bandwidth-caps">
					<span v-if="downloadLimit > 0" class="bandwidth_cap">
						<v-icon icon="mdi-arrow-down" size="12" />{{ formatRate(downloadLimit, locale) }}
					</span>

					<span v-if="uploadLimit > 0" class="bandwidth_cap">
						<v-icon icon="mdi-arrow-up" size="12" />{{ formatRate(uploadLimit, locale) }}
					</span>
				</span>
			</v-btn>
		</template>

		<v-card class="bandwidth_card" data-test="bandwidth-panel" :width="360">
			<v-card-title class="text-subtitle-1">{{ $t('bandwidth.title') }}</v-card-title>

			<v-card-subtitle class="pb-2">
				{{ $t('bandwidth.current', { rate: formatRate(rate, locale) }) }}
			</v-card-subtitle>

			<v-card-text>
				<v-form v-form="form">
					<FormMainError :form="form" />

					<div class="bandwidth_section">
						<div class="bandwidth_label text-caption text-medium-emphasis">
							<v-icon icon="mdi-arrow-down" size="14" />
							{{ $t('bandwidth.download') }}
						</div>

						<div class="bandwidth_presets">
							<v-chip
								v-for="preset of presets"
								:key="`down-${preset.bytes}`"
								:color="preset.bytes === downloadLimit ? 'primary' : undefined"
								data-test="bandwidth-download-preset"
								:disabled="applying"
								label
								size="small"
								:variant="preset.bytes === downloadLimit ? 'flat' : 'tonal'"
								@click="choose('download', preset.bytes)"
							>
								{{ preset.label }}
							</v-chip>
						</div>

						<div class="bandwidth_field">
							<v-text-field
								v-model.number="model.download"
								v-bind="form.field('download')"
								data-test="bandwidth-download"
								density="compact"
								hide-details="auto"
								:label="$t('bandwidth.custom')"
								:placeholder="$t('bandwidth.no_cap')"
								type="number"
							/>

							<v-select
								v-model="model.downloadUnit"
								class="bandwidth_unit"
								data-test="bandwidth-download-unit"
								density="compact"
								hide-details
								item-title="title"
								item-value="value"
								:items="unitItems"
							/>
						</div>
					</div>

					<div class="bandwidth_section mt-4">
						<div class="bandwidth_label text-caption text-medium-emphasis">
							<v-icon icon="mdi-arrow-up" size="14" />
							{{ $t('bandwidth.upload') }}
						</div>

						<div class="bandwidth_presets">
							<v-chip
								v-for="preset of presets"
								:key="`up-${preset.bytes}`"
								:color="preset.bytes === uploadLimit ? 'primary' : undefined"
								data-test="bandwidth-upload-preset"
								:disabled="applying"
								label
								size="small"
								:variant="preset.bytes === uploadLimit ? 'flat' : 'tonal'"
								@click="choose('upload', preset.bytes)"
							>
								{{ preset.label }}
							</v-chip>
						</div>

						<div class="bandwidth_field">
							<v-text-field
								v-model.number="model.upload"
								v-bind="form.field('upload')"
								data-test="bandwidth-upload"
								density="compact"
								hide-details="auto"
								:label="$t('bandwidth.custom')"
								:placeholder="$t('bandwidth.no_cap')"
								type="number"
							/>

							<v-select
								v-model="model.uploadUnit"
								class="bandwidth_unit"
								data-test="bandwidth-upload-unit"
								density="compact"
								hide-details
								item-title="title"
								item-value="value"
								:items="unitItems"
							/>
						</div>
					</div>

					<p class="bandwidth_hint text-caption text-medium-emphasis mt-3 mb-0">
						{{ $t('bandwidth.hint') }}
					</p>
				</v-form>
			</v-card-text>

			<v-card-actions>
				<v-spacer />

				<v-btn size="small" variant="text" @click="open = false">
					{{ $t('actions.close') }}
				</v-btn>

				<v-btn
					color="primary"
					data-test="bandwidth-apply"
					:loading="form.loading"
					size="small"
					@click="form.handle"
				>
					{{ $t('bandwidth.apply') }}
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-menu>
</template>

<style lang="scss">
	.bandwidth {
		text-transform: none;

		&_rate {
			font-variant-numeric: tabular-nums;
			font-weight: 500;
		}

		&_caps {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			margin-left: 8px;
			padding: 1px 6px;
			border-radius: 999px;
			background: rgba(var(--v-theme-state-outdated), 0.2);
			color: rgb(var(--v-theme-state-outdated));
			font-size: 11px;
			font-weight: 600;
		}

		&_cap {
			display: inline-flex;
			align-items: center;
			gap: 1px;
			white-space: nowrap;
		}

		&_label {
			display: flex;
			align-items: center;
			gap: 4px;
			margin-bottom: 6px;
		}

		&_presets {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
			margin-bottom: 10px;
		}

		&_field {
			display: flex;
			align-items: flex-start;
			gap: 8px;
		}

		&_unit {
			max-width: 110px;
		}
	}
</style>
