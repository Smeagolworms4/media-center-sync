import { InitialSchema1758240000000 } from './1758240000000-InitialSchema';
import { MediaCompanions1758330000000 } from './1758330000000-MediaCompanions';
import { PeerDirection1758340000000 } from './1758340000000-PeerDirection';
import { DropCatalogueOnly1758350000000 } from './1758350000000-DropCatalogueOnly';

/**
 * Every migration, in order, as classes rather than a path glob.
 *
 * One list, used by the running application, by the TypeORM CLI and by the test
 * database alike. A glob would keep itself current for the first two and leave the
 * tests on whatever their own hand-written list happened to contain — which is exactly
 * what happened here: a new column existed everywhere except in the schema the
 * repository tests were written against, and twelve of them failed with
 * `table media_items has no column named companions` rather than with anything about
 * a missing migration.
 *
 * Adding a migration means adding a line here. Forgetting it now fails the same way in
 * every context instead of only in one.
 */
export const MIGRATIONS = [
	InitialSchema1758240000000,
	MediaCompanions1758330000000,
	PeerDirection1758340000000,
	DropCatalogueOnly1758350000000,
];

export * from './1758240000000-InitialSchema';
export * from './1758330000000-MediaCompanions';
export * from './1758340000000-PeerDirection';
export * from './1758350000000-DropCatalogueOnly';
