<script lang="ts" setup>
	import { useRouter } from 'vue-router';
	import EmptyState from '@/components/common/EmptyState.vue';
	import { useAuthStore } from '@/stores/auth';

	const router = useRouter();
	const authStore = useAuthStore();

	function goHome (): void {
		// A visitor with no session has no dashboard to go back to.
		void router.push({ name: authStore.authenticated ? 'dashboard' : 'login' });
	}
</script>

<template>
	<div class="page-container">
		<v-card>
			<v-card-text>
				<EmptyState
					icon="mdi-map-marker-question-outline"
					:text="$t('pages.not_found_text')"
					:title="$t('pages.not_found')"
				>
					<v-btn color="primary" variant="tonal" @click="goHome">
						{{ authStore.authenticated ? $t('actions.back_home') : $t('actions.sign_in') }}
					</v-btn>
				</EmptyState>
			</v-card-text>
		</v-card>
	</div>
</template>
