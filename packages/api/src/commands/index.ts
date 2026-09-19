/**
 * Only the shared helpers.
 *
 * The commands themselves run their work as a side effect of being loaded, which is
 * what makes them runnable with `ts-node src/commands/<name>.ts`. Re-exporting them
 * here would mean that importing this barrel — for the helpers, say — executes every
 * command in the folder.
 */
export * from './context';
