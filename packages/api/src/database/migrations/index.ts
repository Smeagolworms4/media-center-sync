import { InitialSchema1758240000000 } from './1758240000000-InitialSchema';

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
 *
 * There is exactly one entry because the nineteen that used to follow `InitialSchema`
 * were folded back into it before the first release; that file says what it cost and
 * why it is no longer an option. From here on the list only grows.
 */
export const MIGRATIONS = [InitialSchema1758240000000];

export * from './1758240000000-InitialSchema';
