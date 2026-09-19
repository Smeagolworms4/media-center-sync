<script lang="ts" setup>
	import type { MediaService } from '@mcs/shared';
	import { computed } from 'vue';

	/**
	 * Which source a pull should use, for this run only.
	 *
	 * Left alone it follows the priority configured once in the settings, and the
	 * list says so rather than showing an empty selection: pinning a source into
	 * every run would mean revisiting them all the day a friend's server moves.
	 */
	const props = withDefaults(defineProps<{
		services: MediaService[];
		/** Peer names by identifier, for the sources reached through a friend. */
		peerNames?: Record<string, string>;
		disabled?: boolean;
	}>(), {
		peerNames: () => ({}),
		disabled: false,
	});

	const selected = defineModel<string | null>({ default: null });

	/** Lowest priority first — the order the gateway itself would consult them in. */
	const ordered = computed(() => {
		// `toSorted` would be cleaner, but it is not in the library version this
		// build targets; the copy is what keeps `sort` from reordering the array
		// under everything that renders it.
		// eslint-disable-next-line unicorn/no-array-sort
		return [...props.services].sort((a, b) => a.priority - b.priority);
	});

	const defaultService = computed(() => ordered.value[0] ?? null);

	function peerNameOf (service: MediaService): string | null {
		return service.peerId ? props.peerNames[service.peerId] ?? null : null;
	}
</script>

<template>
	<div class="source-picker" data-test="source-picker">
		<p class="text-caption text-medium-emphasis mb-1">{{ $t('media.source.title') }}</p>

		<v-radio-group
			v-model="selected"
			class="source-picker_group"
			:disabled="disabled"
			hide-details
		>
			<v-radio class="source-picker_default" data-test="source-default" :value="null">
				<template #label>
					<span>
						{{ $t('media.source.follow_priority') }}
						<span v-if="defaultService" class="text-medium-emphasis">
							{{ $t('media.source.follow_priority_hint', { name: defaultService.name }) }}
						</span>
					</span>
				</template>
			</v-radio>

			<v-radio
				v-for="service of ordered"
				:key="service.id"
				class="source-picker_option"
				data-test="source-option"
				:value="service.id"
			>
				<template #label>
					<span>
						{{ service.name }}
						<span class="text-caption text-medium-emphasis">
							· {{ $t('media.source.priority', { priority: service.priority }) }}
							<template v-if="peerNameOf(service)">
								· {{ $t('media.source.via_peer', { peer: peerNameOf(service) }) }}
							</template>
						</span>
					</span>
				</template>
			</v-radio>
		</v-radio-group>

		<p v-if="ordered.length === 0" class="text-caption text-medium-emphasis">
			{{ $t('media.source.none') }}
		</p>
	</div>
</template>

<style lang="scss">
	.source-picker {
		&_group {
			margin-top: 0;
		}
	}
</style>
