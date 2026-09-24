/*
 * Pure functions and word lists only, and there is a reason to keep it that way.
 *
 * `app.module` registers every class a service barrel exports, so a class added here
 * would become a provider. Nothing in this folder needs one: the detector has no state,
 * no I/O and no configuration, which is what makes it testable by handing it facts and
 * reading the answer.
 */
export * from './classifier';
export * from './signals';
export * from './vocabulary';
