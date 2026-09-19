import type { HEntreprise, HService } from '@/models';

type ServiceNN = NonNullable<HService>;

/**
 * Index `(entrepriseRcuId, serviceId)` des services RCU **actifs** (affaire `statutAffaire = ACT`)
 * accessibles depuis les entreprises passées.
 *
 * Sert de référentiel « ce service existe bien côté RCU » pour décider si une habilitation HAB
 * est orpheline.
 */
export function activeServiceKeys(entreprises: HEntreprise[]): Set<string> {
	const keys = new Set<string>();
	for (const entreprise of entreprises) {
		if (!entreprise) continue;
		const entrepriseRcuId = entreprise.rcuId?.value ?? '';
		for (const etab of (entreprise.etablissements ?? [])) {
			if (!etab) continue;
			for (const affaire of (etab.affaires ?? [])) {
				if (!affaire || affaire.statusAffaire?.value !== 'ACT') continue;
				for (const service of affaire.services) {
					const id = service?.id?.value;
					if (id) {
						keys.add(entrepriseRcuId + '|' + id);
					}
				}
			}
		}
	}
	return keys;
}

/**
 * Habilitations HAB **orphelines** : celles qui ne correspondent à aucun service RCU actif des
 * entreprises données.
 *
 * Deux cas : `id` vide (application HAB non rattachée à un service catalogue), ou couple
 * `(clientId, id)` absent de l'index.
 */
export function orphanHabilitations(habilitations: HService[], entreprises: HEntreprise[]): ServiceNN[] {
	const keys = activeServiceKeys(entreprises);
	return habilitations
		.filter((h): h is ServiceNN => !!h)
		.filter(h => {
			const id = h.id?.value;
			if (!id) return true;
			return !keys.has((h.clientId?.value ?? '') + '|' + id);
		});
}

/**
 * Orphelines **rattachables à une entreprise connue** : leur `clientId` désigne l'entreprise.
 *
 * C'est le niveau le plus fin possible — une credential HAB porte le RCU du client
 * (`clientId`) mais aucun SIRET, on ne peut donc pas la ramener à un établissement précis.
 */
export function orphanHabilitationsOfEntreprise(
	habilitations: HService[],
	entreprise: NonNullable<HEntreprise>,
): ServiceNN[] {
	const entrepriseRcuId = entreprise.rcuId?.value ?? '';
	if (!entrepriseRcuId) return [];
	return orphanHabilitations(habilitations, [entreprise])
		.filter(h => h.clientId?.value === entrepriseRcuId);
}

/**
 * Orphelines **non rattachables** : aucune entreprise affichée ne correspond à leur `clientId`
 * (client inconnu du RCU, ou credential sans `clientId`). Ce sont les seules qui doivent rester
 * dans le bloc de bas de page.
 */
export function unattachedOrphanHabilitations(
	habilitations: HService[],
	entreprises: HEntreprise[],
): ServiceNN[] {
	const knownRcuIds = new Set(
		entreprises
			.map(e => e?.rcuId?.value)
			.filter((id): id is string => !!id),
	);
	return orphanHabilitations(habilitations, entreprises)
		.filter(h => !knownRcuIds.has(h.clientId?.value ?? ''));
}
