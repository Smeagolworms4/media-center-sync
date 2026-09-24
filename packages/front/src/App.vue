<script lang="ts" setup>
	import { Right } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import { useI18n } from 'vue-i18n';
	import { useRoute, useRouter } from 'vue-router';
	import { useTheme } from 'vuetify';
	import Notify from '@/components/Notify.vue';
	import BandwidthControl from '@/components/transfer/BandwidthControl.vue';
	import { useAppInit } from '@/hooks/useAppInit';
	import { useNotifier } from '@/hooks/useNotifier';
	import { useRouteGranted } from '@/plugins/granted';
	import { SUPPORTED_LOCALES, type SupportedLocale } from '@/plugins/i18n';
	import { storeTheme, type ThemeName } from '@/plugins/vuetify';
	import { routes } from '@/router';
	import { useAuthStore } from '@/stores/auth';
	import { useEventsStore } from '@/stores/events';
	import { useI18nStore } from '@/stores/i18n';
	import { useLoaderStore } from '@/stores/loader';
	import { useTransfersStore } from '@/stores/transfers';

	const { t } = useI18n();
	const transfersStore = useTransfersStore();
	const { notify, tryCallback } = useNotifier();

	/**
	 * Stop everything that is moving, from wherever somebody happens to be.
	 *
	 * One request rather than one per row, because pausing a queue row by row cannot
	 * work: by the time the fourth is paused the engine has started a fifth.
	 */
	const pausing = ref(false);

	const pauseEverything = tryCallback(async () => {
		pausing.value = true;
		try {
			await transfersStore.pauseAll();

			void notify('transfer.paused_all');
		} finally {
			pausing.value = false;
		}
	});
	const route = useRoute();
	const router = useRouter();
	const theme = useTheme();

	const authStore = useAuthStore();
	const eventsStore = useEventsStore();
	const i18nStore = useI18nStore();
	const loaderStore = useLoaderStore();

	const { ready, init } = useAppInit();

	const drawer = ref(true);

	onMounted(() => {
		void init();
	});

	/**
	 * The shell only makes sense once somebody is signed in. The sign-in page and
	 * the 404 render on their own, which is also what keeps the drawer from
	 * flashing open behind the login card.
	 */
	const showShell = computed(
		() => authStore.authenticated && route.name !== 'login' && route.name !== 'setup');

	// A menu entry the viewer cannot open is worse than no entry at all: it
	// advertises a page and then bounces them off it.
	const routeGranted = useRouteGranted();
	const navItems = computed(() =>
		routes
			.filter(one => one.meta?.nav && one.name)
			.filter(one => routeGranted(String(one.name))));

	const currentTheme = computed<ThemeName>(
		() => (theme.global.name.value === 'light' ? 'light' : 'dark'));

	function toggleTheme (): void {
		const next: ThemeName = currentTheme.value === 'dark' ? 'light' : 'dark';
		void theme.change(next);
		storeTheme(next);
	}

	const connectionIcon = computed(() => {
		switch (eventsStore.state) {
		case 'open': { return 'mdi-access-point';
		}
		case 'connecting': { return 'mdi-access-point-network-off';
		}
		default: { return 'mdi-access-point-off';
		}
		}
	});

	const connectionColor = computed(() => {
		switch (eventsStore.state) {
		case 'open': { return 'state-in-sync';
		}
		case 'connecting': { return 'state-outdated';
		}
		default: { return 'state-unknown';
		}
		}
	});

	const connectionLabel = computed(() => {
		switch (eventsStore.state) {
		case 'open': { return t('connection.online');
		}
		case 'connecting': { return t('connection.connecting');
		}
		default: { return t('connection.offline');
		}
		}
	});

	const accountName = computed(
		() => authStore.user?.displayName || authStore.user?.username || '');

	async function signOut (): Promise<void> {
		await authStore.logout();
		eventsStore.disconnect();
		await router.push({ name: 'login' });
	}

	function changeLocale (locale: SupportedLocale): void {
		i18nStore.setLocale(locale);
	}
</script>

<template>
	<v-app class="app">
		<template v-if="showShell">
			<v-navigation-drawer v-model="drawer" data-test="app-nav" :width="248">
				<v-list class="app_nav" density="comfortable" nav>
					<v-list-item
						v-for="item of navItems"
						:key="String(item.name)"
						:data-test="`nav-${String(item.name)}`"
						:prepend-icon="item.meta?.icon"
						:title="$t(item.meta?.title ?? '')"
						:to="{ name: item.name }"
					/>
				</v-list>
			</v-navigation-drawer>

			<v-app-bar data-test="app-shell" flat :height="56">
				<v-app-bar-nav-icon @click="drawer = !drawer" />
				<v-app-bar-title class="app_title">{{ $t('app.name') }}</v-app-bar-title>

				<!--
					The bandwidth caps live here rather than on the transfers page: they
					are changed while looking at something else, and the app bar is the
					only surface that is on every screen.
				-->
				<BandwidthControl v-if="$isGranted(Right.SETTINGS_MANAGE)" />

				<!--
					Beside the caps, and for the same reason: it is reached while looking at
					something else. The disk is filling or the link is needed now, and
					walking to the transfers page to stop a queue that keeps starting new
					rows underneath is not an answer.
				-->
				<v-tooltip location="bottom" :text="$t('transfer.pause_all')">
					<template #activator="{ props: tooltipProps }">
						<v-btn
							v-if="$isGranted(Right.TRANSFER_MANAGE)"
							v-bind="tooltipProps"
							data-test="app-pause-all"
							icon="mdi-pause-octagon-outline"
							:loading="pausing"
							variant="text"
							@click="pauseEverything"
						/>
					</template>
				</v-tooltip>

				<v-tooltip location="bottom" :text="connectionLabel">
					<template #activator="{ props: tooltipProps }">
						<v-btn
							v-bind="tooltipProps"
							class="app_connection"
							:color="connectionColor"
							:icon="connectionIcon"
							variant="text"
						/>
					</template>
				</v-tooltip>

				<v-tooltip location="bottom" :text="$t('theme.toggle')">
					<template #activator="{ props: tooltipProps }">
						<v-btn
							v-bind="tooltipProps"
							:icon="currentTheme === 'dark' ? 'mdi-weather-night' : 'mdi-weather-sunny'"
							variant="text"
							@click="toggleTheme"
						/>
					</template>
				</v-tooltip>

				<v-menu location="bottom end">
					<template #activator="{ props: menuProps }">
						<v-btn v-bind="menuProps" class="app_account" data-test="account-menu" variant="text">
							<v-icon class="mr-2" icon="mdi-account-circle-outline" />
							{{ accountName }}
						</v-btn>
					</template>

					<v-list density="compact">
						<v-list-subheader>{{ $t('locale.label') }}</v-list-subheader>

						<v-list-item
							v-for="locale of SUPPORTED_LOCALES"
							:key="locale"
							:active="i18nStore.locale === locale"
							:title="$t(`locale.${locale}`)"
							@click="changeLocale(locale)"
						/>

						<v-divider class="my-1" />

						<v-list-item
							data-test="account-logout"
							prepend-icon="mdi-logout"
							:title="$t('actions.sign_out')"
							@click="signOut"
						/>
					</v-list>
				</v-menu>
			</v-app-bar>
		</template>

		<v-main>
			<!--
				Until the boot restore has answered, nothing below can decide what to
				show: a router-view rendered too early either flashes the sign-in page
				at somebody who is signed in, or renders a page whose data needs a
				bearer that does not exist yet.
			-->
			<div v-if="!ready" class="app_boot">
				<v-progress-circular color="primary" indeterminate size="42" />
				<p class="text-body-2 text-medium-emphasis mt-4">{{ $t('app.loading') }}</p>
			</div>

			<template v-else>
				<v-progress-linear
					v-if="loaderStore.loading"
					class="app_loading"
					color="primary"
					height="2"
					indeterminate
				/>

				<router-view />
			</template>
		</v-main>

		<Notify />
	</v-app>
</template>

<style lang="scss">
	.app {
		&_title {
			font-weight: 600;
		}

		&_boot {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			min-height: 60vh;
		}

		&_loading {
			position: absolute;
			top: 0;
			left: 0;
			z-index: 5;
		}
	}
</style>
