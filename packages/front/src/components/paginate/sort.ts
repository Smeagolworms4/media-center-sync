/**
 * Sort direction, as the table header cycles it.
 *
 * Deliberately local: this is a presentation concern of the table component, and
 * it happens to serialise to the same two words as the `direction` field of the
 * search queries in `@mcs/shared`, so a page can pass one straight to the other.
 */
export enum AscDesc {
	ASC = 'asc',
	DESC = 'desc',
}
