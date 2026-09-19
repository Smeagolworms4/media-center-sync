<script lang="ts" setup>
	import type { User } from '@mcs/shared';
	import { UserRole } from '@mcs/shared';
	import { computed, onMounted, ref } from 'vue';
	import { useI18n } from 'vue-i18n';
	import EmptyState from '@/components/common/EmptyState.vue';
	import ErrorState from '@/components/common/ErrorState.vue';
	import PageHeader from '@/components/common/PageHeader.vue';
	import RelativeDate from '@/components/common/RelativeDate.vue';
	import Confirm from '@/components/Confirm.vue';
	import { useNotifier } from '@/hooks/useNotifier';
	import { isMirroredUser, useUsersStore } from '@/stores/users';

	defineOptions({ name: 'SettingsUsersPage' });

	/**
	 * The accounts.
	 *
	 * An account mirrored from a media service cannot have its username or its
	 * password changed here, and the screen says so in words rather than showing a
	 * greyed field: a disabled input with no explanation reads as a bug, and the
	 * reason — the gateway does not own that account — is the useful part.
	 */
	const { t } = useI18n();
	const usersStore = useUsersStore();
	const { notify, tryCallback } = useNotifier();

	const failed = ref(false);
	const busyId = ref<string | null>(null);
	const removing = ref<User | null>(null);
	const removeBusy = ref(false);

	async function load (): Promise<void> {
		failed.value = false;
		try {
			await usersStore.load();
		} catch {
			failed.value = true;
		}
	}

	onMounted(() => {
		void load();
	});

	const users = computed(() => usersStore.users);
	const roles = computed(() => Object.values(UserRole).map(value => ({
		value,
		title: t(`user.role.${value}`),
	})));

	const changeRole = tryCallback(async (user: User, role: UserRole) => {
		if (role === user.role) {
			return;
		}
		busyId.value = user.id;
		try {
			await usersStore.update(user.id, { role });
			void notify('user.role_saved');
		} finally {
			busyId.value = null;
		}
	});

	const confirmRemove = tryCallback(async () => {
		if (!removing.value) {
			return;
		}
		removeBusy.value = true;
		try {
			await usersStore.remove(removing.value.id);
			removing.value = null;
			void notify('user.removed');
		} finally {
			removeBusy.value = false;
		}
	});

	/** `service:<uuid>` is a provider key; the part before the colon is the kind. */
	function providerLabel (user: User): string {
		return user.provider.split(':', 1)[0] ?? user.provider;
	}
</script>

<template>
	<div class="page-container settings-users">
		<PageHeader
			icon="mdi-account-multiple-outline"
			:loading="usersStore.loading"
			:subtitle="$t('user.subtitle')"
			:title="$t('pages.settings_users')"
		/>

		<ErrorState v-if="failed" @retry="load" />

		<v-card v-else>
			<EmptyState
				v-if="!usersStore.loading && users.length === 0"
				icon="mdi-account-off-outline"
				:text="$t('user.empty_text')"
				:title="$t('user.empty_title')"
			/>

			<v-table v-else data-test="user-list" density="comfortable">
				<thead>
					<tr>
						<th>{{ $t('user.column.username') }}</th>
						<th>{{ $t('user.column.provider') }}</th>
						<th>{{ $t('user.column.role') }}</th>
						<th>{{ $t('user.column.last_seen') }}</th>
						<th />
					</tr>
				</thead>

				<tbody>
					<tr v-for="user of users" :key="user.id" data-test="user-row">
						<td>
							<p class="mb-0">{{ user.displayName || user.username }}</p>

							<p class="text-caption text-medium-emphasis mb-0">{{ user.username }}</p>
						</td>

						<td>
							<v-chip label size="small" variant="tonal">{{ providerLabel(user) }}</v-chip>

							<p
								v-if="isMirroredUser(user)"
								class="text-caption text-medium-emphasis mb-0 mt-1"
								data-test="user-mirrored"
							>
								{{ $t('user.mirrored_hint') }}
							</p>
						</td>

						<td class="settings-users_role">
							<v-select
								data-test="user-role"
								density="compact"
								hide-details
								item-title="title"
								item-value="value"
								:items="roles"
								:loading="busyId === user.id"
								:model-value="user.role"
								@update:model-value="changeRole(user, $event)"
							/>
						</td>

						<td><RelativeDate :date="user.lastSeenAt" /></td>

						<td class="text-right">
							<v-btn
								color="error"
								data-test="user-remove"
								icon="mdi-delete-outline"
								size="small"
								variant="text"
								@click="removing = user"
							/>
						</td>
					</tr>
				</tbody>
			</v-table>
		</v-card>

		<Confirm
			:loading="removeBusy"
			:model-value="removing !== null"
			:text="$t('user.remove_confirm', { name: removing?.username ?? '' })"
			:title="$t('user.remove_title')"
			@cancel="removing = null"
			@confirm="confirmRemove"
		/>
	</div>
</template>

<style lang="scss">
	.settings-users {
		&_role {
			min-width: 160px;
		}
	}
</style>
