<script lang="ts" setup>
	import { ref } from 'vue';
	import { useNotifier } from '@/hooks/useNotifier';

	/**
	 * A value that only exists to be handed to somebody else — a fingerprint, an
	 * invitation URL, this gateway's own address.
	 *
	 * It stays selectable text as well as a button: the clipboard API is refused
	 * outside a secure context, and a gateway reached over plain HTTP on a home
	 * network is exactly that case.
	 */
	const props = withDefaults(defineProps<{
		label?: string | null;
		value: string;
		/** Long opaque values wrap; short ones read better on one line. */
		wrap?: boolean;
	}>(), {
		label: null,
		wrap: false,
	});

	const { notify } = useNotifier();
	const copied = ref(false);

	async function copy (): Promise<void> {
		try {
			await navigator.clipboard.writeText(props.value);
			copied.value = true;
			setTimeout(() => {
				copied.value = false;
			}, 2000);
		} catch {
			// Nothing else to do: the value is on screen and can be selected by hand.
			void notify('common.copy_failed', 'warning');
		}
	}
</script>

<template>
	<div class="copy-field">
		<p v-if="label" class="copy-field_label text-caption text-medium-emphasis">{{ label }}</p>

		<div class="copy-field_row">
			<code class="copy-field_value" :class="{ 'copy-field_value--wrap': wrap }">{{ value }}</code>

			<v-tooltip location="top" :text="copied ? $t('actions.copied') : $t('actions.copy')">
				<template #activator="{ props: tooltipProps }">
					<v-btn
						v-bind="tooltipProps"
						class="copy-field_button"
						data-test="copy-button"
						:icon="copied ? 'mdi-check' : 'mdi-content-copy'"
						size="small"
						variant="text"
						@click="copy"
					/>
				</template>
			</v-tooltip>
		</div>
	</div>
</template>

<style lang="scss">
	.copy-field {
		&_label {
			margin: 0 0 2px;
		}

		&_row {
			display: flex;
			align-items: center;
			gap: 8px;
		}

		&_value {
			@include truncate;
			flex: 1 1 auto;
			font-size: 13px;
			padding: 4px 8px;
			border-radius: 4px;
			background: rgba(var(--v-theme-on-surface), 0.06);

			&--wrap {
				white-space: normal;
				overflow-wrap: anywhere;
			}
		}
	}
</style>
