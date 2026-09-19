export function slugify (input: string): string {
	return input
		.trim()
		.toLowerCase()
		// Strip accents: NFD splits a letter from its diacritic, which then drops.
		.normalize('NFD')
		.replace(/[\u0300-\u036F]/g, '')
		// Anything that is not alphanumeric becomes a hyphen,
		.replace(/[^a-z0-9]+/g, '-')
		// and runs of hyphens collapse.
		.replace(/^-+|-+$/g, '')
		.replace(/-+/g, '-');
}

export function capitalize (str?: string | null): string {
	return str?.replace(/\b\w/g, c => c.toUpperCase()) ?? '';
}
