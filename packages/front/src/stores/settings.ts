import type { Settings, UpdateSettingsRequest } from '@mcs/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
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

	const { caller } = useCaller();

	async function load (): Promise<Settings> {
		settings.value = await caller('api').get<Settings>('/settings');
		loaded.value = true;
		return settings.value;
	}

	async function save (patch: UpdateSettingsRequest): Promise<Settings> {
		settings.value = await caller('api').patch<Settings>('/settings', patch);
		return settings.value;
	}

	return { settings, loaded, load, save };
});
