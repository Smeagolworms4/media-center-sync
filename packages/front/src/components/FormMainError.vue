<template>
	<span v-if="form.mainError" class="form-main-error mb-4">
		<template v-for="(line, index) of lines" :key="index">
			<br v-if="index !== 0" />{{ line }}
		</template>
	</span>
</template>

<script lang="ts" setup>
	import { computed } from 'vue';
	import type { IForm } from '@/composables/useForm';

	const props = defineProps<{ form: IForm }>();

	const lines = computed(() => (props.form.mainError ?? '').split('\n'));
</script>

<style lang="scss">
	.form-main-error {
		color: rgb(var(--v-theme-error));
		font-size: 14px;
		display: block;
	}
</style>
