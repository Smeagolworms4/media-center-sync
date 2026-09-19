<script lang="ts" setup>
	import PageHeader from '@/components/common/PageHeader.vue';

	// Placeholder. The header and the card are the frame every page in this
	// application uses; the body is filled in by the screens that follow.
	defineOptions({ name: 'PeerPage' });
</script>

<template>
	<div class="page-container">
		<PageHeader icon="mdi-account-outline" :title="$t('pages.peer')" />

		<v-card>
			<v-card-text class="text-medium-emphasis">
				{{ $t('common.placeholder') }}
			</v-card-text>
		</v-card>
	</div>
</template>
