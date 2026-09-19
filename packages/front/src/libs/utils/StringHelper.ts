export function slugify (input: string): string {
	return input
		.trim()
		.toLowerCase()
		// 1) enlève les accents (NFD sépare lettre + diacritique)
		.normalize('NFD')
		.replace(/[\u0300-\u036F]/g, '')
		// 2) remplace tout ce qui n'est pas alphanum par des tirets
		.replace(/[^a-z0-9]+/g, '-')
		// 3) supprime les tirets en trop
		.replace(/^-+|-+$/g, '')
		.replace(/-+/g, '-');
}

export function capitalize (str?: string | null): string {
	return str?.replace(/\b\w/g, c => c.toUpperCase()) ?? '';
}
