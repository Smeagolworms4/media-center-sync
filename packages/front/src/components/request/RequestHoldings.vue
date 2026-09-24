<script lang="ts" setup>
	import type { RequestHolding } from '@mcs/shared';

	/**
	 * The copies of ours that answer an ask.
	 *
	 * Every one of them names the machine it sits on, because "we hold it" is the
	 * sentence somebody is about to close a request on and it has to be checkable: a
	 * household with a Jellyfin, a Plex and a friend's gateway is told which of the
	 * three, and can walk to it. The name comes from the services list the page
	 * already holds; the identifier is shown when nothing names it rather than
	 * nothing at all, since an unnamed service is still a traceable one.
	 */
	const props = withDefaults(defineProps<{
		holdings: RequestHolding[];
		/** Service identifier to display name, read from the services store by the page. */
		serviceNames?: Record<string, string>;
	}>(), {
		serviceNames: () => ({}),
	});

	function serviceName (serviceId: string): string {
		return props.serviceNames[serviceId] ?? serviceId;
	}
</script>

<template>
	<div class="request-holdings" data-test="request-holdings">
		<span class="text-caption text-medium-emphasis">{{ $t('request.holdings') }}</span>

		<span
			v-for="holding of holdings"
			:key="holding.itemId"
			class="request-holdings_one"
			:data-service="holding.serviceId"
			data-test="request-holding"
		>
			<!--
				A link to our own copy rather than a name on its own: the media page is
				where a missing season is actually fetched, and this screen deliberately
				cannot do that.
			-->
			<router-link
				class="request-holdings_link"
				data-test="request-holding-link"
				:to="{ name: 'library-item', params: { itemId: holding.itemId } }"
			>
				{{ holding.title }}
			</router-link>

			<span class="text-caption text-medium-emphasis" data-test="request-holding-service">
				{{ serviceName(holding.serviceId) }}
			</span>

			<span
				v-if="holding.seasonNumbers.length > 0"
				class="text-caption text-medium-emphasis"
				data-test="request-holding-seasons"
			>
				{{ $t('request.seasons', { seasons: holding.seasonNumbers.join(', ') }) }}
			</span>
		</span>
	</div>
</template>

<style lang="scss">
	.request-holdings {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 4px 8px;

		&_one {
			display: inline-flex;
			align-items: baseline;
			flex-wrap: wrap;
			gap: 6px;
		}

		&_link {
			color: inherit;
			font-size: 13px;
		}
	}
</style>
