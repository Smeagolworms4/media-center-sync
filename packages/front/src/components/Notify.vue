<script lang="ts" setup>
	import { ref } from 'vue';
	import { useNotifierStore } from '@/stores/notifier';

	const el = ref<HTMLElement>();
	const notifierStore = useNotifierStore();
</script>

<template>
	<teleport to="body">
		<div ref="el" class="components-notify">
			<transition-group name="fade">
				<template v-for="(notify, _key) of notifierStore.notifies" :key="_key">
					<div
						class="components-notify_card"
						:class="[
							`components-notify_card--${notify.type}`,
						]"
						data-test="notify"
					>
						{{ notify.message }}
					</div>
				</template>
			</transition-group>
		</div>
	</teleport>
</template>

<style lang="scss">

	.components-notify {
		position: fixed;
		top: 80px;
		right: 15px;
		z-index: 1000000;

		&_card {

			padding: 15px;
			margin-bottom: 15px;
			border-radius: 4px;
			border: 1px solid #d6e9c6 !important;;
			background: #dff0d8 !important;;
			color: #3c763d;
			width: 200px;
			font-size: 15px;

			&--error {
				color: #a94442;
				background-color: #f2dede !important;
				border-color: #ebccd1 !important;;
			}
			&--warning {
				color: #8a6d3b;
				background-color: #fcf8e3 !important;;
				border-color: #faebcc !important;;
			}
		}

	}
</style>
