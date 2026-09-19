import { parsePhoneNumber } from 'awesome-phonenumber';

/**
 * Formate un numéro de téléphone au format international lisible.
 * Ex: "0033612345678" → "+33 6 12 34 56 78"
 *     "0612345678"    → "06 12 34 56 78"
 *
 * @param value Numéro brut (format 00XX ou local)
 * @param defaultRegion Code pays par défaut (ex: 'FR')
 */
export function formatPhone(
	value: string | null | undefined,
	defaultRegion: string = 'FR',
): string {
	if (!value) return '';

	// Convertir le format 00XX en +XX
	let normalized = value;
	if (normalized.startsWith('00')) {
		normalized = '+' + normalized.substring(2);
	}

	const pn = parsePhoneNumber(normalized, { regionCode: defaultRegion });
	if (pn.valid) {
		return pn.number?.international ?? value;
	}

	return value;
}
