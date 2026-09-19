<script lang="ts" setup>
	withDefaults(defineProps<{
		title: string;
		subtitle?: string | null;
		icon?: string | null;
		/** Shown while the page is fetching, so the header does not jump into place. */
		loading?: boolean;
	}>(), {
		subtitle: null,
		icon: null,
		loading: false,
	});
</script>

<template>
	<header class="page-header mb-4">
		<div class="page-header_main">
			<v-icon v-if="icon" class="page-header_icon" :icon="icon" size="28" />

			<div class="page-header_text">
				<h1 class="page-header_title text-h5" data-test="page-title">{{ title }}</h1>

				<p v-if="subtitle" class="page-header_subtitle text-body-2 text-medium-emphasis">
					{{ subtitle }}
				</p>
			</div>

			<v-spacer />

			<div class="page-header_actions">
				<slot name="actions" />
			</div>
		</div>

		<v-progress-linear
			v-if="loading"
			class="page-header_progress"
			color="primary"
			height="2"
			indeterminate
		/>
	</header>
</template>

<style lang="scss">
	.page-header {
		&_main {
			display: flex;
			align-items: center;
			gap: 12px;
		}

		&_title {
			@include truncate;
			line-height: 1.2;
		}

		&_subtitle {
			margin: 2px 0 0;
		}

		&_actions {
			display: flex;
			align-items: center;
			gap: 8px;
		}

		&_progress {
			margin-top: 8px;
		}
	}
</style>
