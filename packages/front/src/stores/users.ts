import type { UpdateUserRequest, User } from '@mcs/shared';
import { AuthProviderType } from '@mcs/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useCaller } from '@/hooks/useCaller';

/**
 * An account the gateway did not issue.
 *
 * Its username and its password live on the media service that authenticated it;
 * changing them here would either fail or drift out of step with the service. The
 * role is ours, and stays editable.
 */
export function isMirroredUser (user: Pick<User, 'provider'>): boolean {
	return user.provider !== AuthProviderType.INTERNAL;
}

export const useUsersStore = defineStore('users', () => {
	const { caller } = useCaller();

	const users = ref<User[]>([]);
	const loading = ref(false);
	const loaded = ref(false);
	const error = ref<unknown>(null);

	function replace (user: User): void {
		const index = users.value.findIndex(one => one.id === user.id);
		if (index === -1) {
			users.value = [...users.value, user];
		} else {
			users.value[index] = user;
		}
	}

	async function load (): Promise<User[]> {
		loading.value = true;
		error.value = null;
		try {
			const loadedList = await caller('api').get<User[]>('/users', { keepLastKey: 'users|list' });
			// An empty body parses to `null`, and a gateway that answers nothing must
			// not leave a page rendering a list that is not one.
			users.value = Array.isArray(loadedList) ? loadedList : [];
			loaded.value = true;
			return users.value;
		} catch (loadError) {
			error.value = loadError;
			throw loadError;
		} finally {
			loading.value = false;
		}
	}

	async function get (id: string): Promise<User> {
		const user = await caller('api').get<User>(`/users/${id}`);
		replace(user);
		return user;
	}

	async function update (id: string, request: UpdateUserRequest): Promise<User> {
		const user = await caller('api').patch<User>(`/users/${id}`, request);
		replace(user);
		return user;
	}

	async function remove (id: string): Promise<void> {
		await caller('api').delete(`/users/${id}`);
		users.value = users.value.filter(one => one.id !== id);
	}

	return {
		users,
		loading,
		loaded,
		error,
		load,
		get,
		update,
		remove,
	};
});
