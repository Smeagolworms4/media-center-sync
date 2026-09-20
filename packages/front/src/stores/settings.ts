import type { Settings, SettingsView, UpdateSettingsRequest } from '@mcs/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';

/**
 * The gateway's own settings.
 *
 * Loaded once at boot because several unrelated screens need one field of it —
 * the transfer list needs the rate cap to draw a ceiling, the library needs the
 * placement strategy to say where a pull would land — and none of them should
 * fetch it again.
 */
export const useSettingsStore = defineStore('settings', () => {
	const settings = ref<Settings | null>(null);
	const loaded = ref(false);
	/**
	 * Fields the deployment pinned in its environment, which the form must show as
	 * read-only.
	 *
	 * It travels with the values rather than being a second request: a form that
	 * rendered before it arrived would offer an editable control for a locked field
	 * and then take it away, and somebody will have typed in it by then.
	 */
	const pinned = ref<string[]>([]);

	const isPinned = computed(() => (field: keyof Settings): boolean =>
		pinned.value.includes(field as string));

	const { caller } = useCaller();

	async function load (): Promise<Settings> {
		const view = await caller('api').get<SettingsView>('/settings');
		// Destructured so that nothing downstream has to remember that this one key is
		// about the form rather than about the gateway.
		const { pinned: pinnedFields, ...values } = view;
		settings.value = values;
		pinned.value = Array.isArray(pinnedFields) ? pinnedFields : [];
		loaded.value = true;
		return settings.value;
	}

	async function save (patch: UpdateSettingsRequest): Promise<Settings> {
		settings.value = await caller('api').patch<Settings>('/settings', patch);
		return settings.value;
	}

	return { settings, loaded, pinned, isPinned, load, save };
});
