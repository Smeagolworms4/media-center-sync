<script lang="ts" setup>
	/**
	 * Where the household asks for things, as one block of the settings screen.
	 *
	 * Every other source on this screen answers "where is this file" — a library, a
	 * friend's gateway, an indexer. This one answers a question none of them can: *what
	 * does anybody actually want*, read from the screen the household already types into.
	 * So it is described rather than merely offered, because an address box labelled
	 * "Seerr" says nothing about which direction anything travels in.
	 *
	 * **Nothing here downloads anything**, and the pane says so. Wiring a request
	 * straight to a transfer would mean a stranger with a Seerr account spending this
	 * gateway's disk, which was rejected on purpose and not for want of the plumbing —
	 * and somebody who assumes otherwise will point this at a public instance.
	 *
	 * There is no test button, and that is the same answer the indexer and the download
	 * client give one card up: no route probes any of the three, and a button that only
	 * checked that the address parses would report success for a Seerr that is down, an
	 * address with the wrong port and a key that was mistyped. A pane that claims to have
	 * tested something is worse than one that does not offer to.
	 */
	const enabled = defineModel<boolean>('enabled', { required: true });
	const baseUrl = defineModel<string>('baseUrl', { required: true });
	/**
	 * Write-only, exactly like the indexer's key.
	 *
	 * The gateway never sends it back — see `SettingsManager.read` — so blank is the
	 * ordinary state of somebody editing the address beside it, and it means "keep the
	 * one you have". `hasApiKey` is what lets the pane say so instead of looking empty.
	 */
	const apiKey = defineModel<string>('apiKey', { required: true });

	withDefaults(defineProps<{
		hasApiKey?: boolean;
		/** Bindings from `useForm().field()`, so a refusal lands under this control. */
		field?: Record<string, unknown>;
		loading?: boolean;
	}>(), {
		hasApiKey: false,
		field: () => ({}),
		loading: false,
	});
</script>

<template>
	<div class="request-source" data-test="settings-request-source">
		<p class="text-caption text-medium-emphasis mb-4" data-test="settings-request-intro">
			{{ $t('settings.request.intro') }}
		</p>

		<v-switch
			v-model="enabled"
			color="primary"
			data-test="settings-request-enabled"
			density="compact"
			:disabled="loading"
			hide-details
			:label="$t('settings.request.enabled')"
		/>

		<v-text-field
			v-model="baseUrl"
			v-bind="field"
			data-test="settings-request-url"
			density="compact"
			:disabled="loading"
			:hint="$t('settings.request.url_help')"
			:label="$t('settings.request.url')"
			persistent-hint
			placeholder="http://jellyseerr:5055"
		/>

		<!--
			Blank keeps what is stored. The hint is the only thing standing between that
			and a key cleared by somebody who came here to correct a port number.
		-->
		<v-text-field
			v-model="apiKey"
			autocomplete="off"
			class="mt-4"
			data-test="settings-request-key"
			density="compact"
			:disabled="loading"
			:hint="hasApiKey ? $t('settings.releases.key_set') : $t('settings.request.key_help')"
			:label="$t('settings.request.key')"
			persistent-hint
			type="password"
		/>
	</div>
</template>
