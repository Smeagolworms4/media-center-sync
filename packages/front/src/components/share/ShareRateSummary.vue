<script lang="ts" setup>
	import type { SharePolicy } from '@mcs/shared';
	import { computed } from 'vue';
	import { useI18n } from 'vue-i18n';
	import Rate from '@/components/common/Rate.vue';
	import { formatRate } from '@/composables/useFormat';

	/**
	 * Every cap that is actually in force, in one place.
	 *
	 * The global upload cap throttles what this gateway sends, and each shared
	 * library can cap what it serves on its own. Both are set on screens that do
	 * not mention the other, so a gateway can end up throttled by a number somebody
	 * typed once, months ago, on the other page — and a gateway that is throttled
	 * and looks unthrottled is a support question waiting to happen.
	 */
	const props = withDefaults(defineProps<{
		/** Bytes per second, as the API expresses every rate. Zero means no cap. */
		uploadRateLimit: number;
		policies?: SharePolicy[];
	}>(), {
		policies: () => [],
	});

	const { locale } = useI18n();

	const capped = computed(() => props.policies.filter(one => one.rateLimit > 0));
	const globalCapped = computed(() => props.uploadRateLimit > 0);
	const globalRate = computed(() => formatRate(props.uploadRateLimit, locale.value));
</script>

<template>
	<div class="share-rate-summary" data-test="share-rate-summary">
		<p class="text-body-2 mb-1">
			<v-icon
				class="mr-1"
				:color="globalCapped ? 'state-outdated' : 'state-in-sync'"
				:icon="globalCapped ? 'mdi-speedometer-slow' : 'mdi-speedometer'"
				size="small"
			/>

			{{ globalCapped
				? $t('share.rate_summary.global', { rate: globalRate })
				: $t('share.rate_summary.global_none') }}
		</p>

		<p v-if="capped.length === 0" class="text-caption text-medium-emphasis mb-0">
			{{ $t('share.rate_summary.libraries_none') }}
		</p>

		<template v-else>
			<p class="text-caption text-medium-emphasis mb-1">
				{{ $t('share.rate_summary.libraries') }}
			</p>

			<ul class="share-rate-summary_list text-caption">
				<!-- Keyed by the library: a row following the gateway default has no
					policy identifier, because no policy row was ever written for it. -->
				<li v-for="policy of capped" :key="policy.libraryId" data-test="share-rate-library">
					{{ policy.libraryName }} — <Rate :rate="policy.rateLimit" />
				</li>
			</ul>
		</template>
	</div>
</template>

<style lang="scss">
	.share-rate-summary {
		&_list {
			margin: 0;
			padding-left: 20px;
		}
	}
</style>
