import { InitialSchema1758240000000 } from './1758240000000-InitialSchema';
import { MediaCompanions1758330000000 } from './1758330000000-MediaCompanions';
import { PeerDirection1758340000000 } from './1758340000000-PeerDirection';
import { DropCatalogueOnly1758350000000 } from './1758350000000-DropCatalogueOnly';
import { CategoriesAndIdentity1758360000000 } from './1758360000000-CategoriesAndIdentity';
import { RelayConsent1758370000000 } from './1758370000000-RelayConsent';
import { PeerProtocol1758380000000 } from './1758380000000-PeerProtocol';
import { IgnoredItems1758390000000 } from './1758390000000-IgnoredItems';
import { SyncScopeAndSpace1758400000000 } from './1758400000000-SyncScopeAndSpace';

/*
 * The thirteen digits at the end of every migration name are not decoration.
 *
 * TypeORM reads `className.substr(-13)` as a JavaScript timestamp, uses it to order
 * migrations against each other, and stores it in the `migrations` table as the record
 * of what has run. A name without it is refused outright — "Migration class name should
 * have a JavaScript timestamp appended" — so it cannot be tidied away.
 *
 * They are chosen rather than generated here, spaced apart and in order, which is why
 * they decode to round hours.
 */

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
	CategoriesAndIdentity1758360000000,
	RelayConsent1758370000000,
	PeerProtocol1758380000000,
	IgnoredItems1758390000000,
	SyncScopeAndSpace1758400000000,
];

export * from './1758240000000-InitialSchema';
export * from './1758330000000-MediaCompanions';
export * from './1758340000000-PeerDirection';
export * from './1758350000000-DropCatalogueOnly';
export * from './1758360000000-CategoriesAndIdentity';
export * from './1758370000000-RelayConsent';
export * from './1758380000000-PeerProtocol';
export * from './1758390000000-IgnoredItems';
export * from './1758400000000-SyncScopeAndSpace';
