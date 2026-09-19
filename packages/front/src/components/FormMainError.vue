<script lang="ts" setup>
	import type { IForm } from '@/composables/useForm';
	import { computed } from 'vue';

	const props = defineProps<{ form: IForm }>();

	const lines = computed(() => (props.form.mainError ?? '').split('\n'));
</script>

<template>
	<span v-if="form.mainError" class="form-main-error mb-4" data-test="form-main-error">
		<template v-for="(line, index) of lines" :key="index">
			<br v-if="index !== 0">{{ line }}
		</template>
	</span>
</template>

<style lang="scss">
	.form-main-error {
		color: rgb(var(--v-theme-error));
		font-size: 14px;
		display: block;
	}
</style>
