import { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver';

/**
 * Teaches the PostgreSQL driver the two spellings the entities rely on.
 *
 * The entities are written once and have to load on both engines, so they declare
 * `datetime` — the only spelling SQLite accepts — and let the driver render the
 * dialect. TypeORM's PostgreSQL driver already converts `datetime` values on the way
 * in and out, but its type allow list does not carry the name, so `DataSource.initialize()`
 * refuses every timestamp column before a single query runs. Adding the alias here
 * keeps one entity definition instead of two.
 *
 * The others are about identifiers. `uuid` is a PostgreSQL type and not a SQLite one,
 * and `@PrimaryGeneratedColumn('uuid')` lets PostgreSQL fill it through a column
 * default — `uuid_generate_v4()`, which the migration cannot create because SQLite
 * has no such function. The migration therefore stores identifiers as `varchar` on
 * both engines, and the driver is told two matching things: that a UUID column is a
 * `varchar`, and that it does not generate identifiers, so TypeORM produces them in
 * the application exactly as it already does on SQLite. The same rows, whichever
 * engine is behind them, and a schema the entities still describe.
 *
 * Removing any of these leaves a gateway that works on SQLite and fails on PostgreSQL
 * — at startup for the first, at the first insert for the others — with an error that
 * names the driver rather than this choice.
 */
export const applyPostgresCompatibility = (): void => {
	const driver = PostgresDriver.prototype as unknown as {
		normalizeType(column: { type?: unknown }): string;
		isUUIDGenerationSupported(): boolean;
		__mcsCompatible?: boolean;
	};

	if (driver.__mcsCompatible === true) {
		return;
	}

	const normalizeType = driver.normalizeType;

	driver.normalizeType = function (column: { type?: unknown }): string {
		if (column.type === 'datetime') {
			return 'timestamp without time zone';
		}

		if (column.type === 'uuid') {
			return 'character varying';
		}

		return normalizeType.call(this, column);
	};

	driver.isUUIDGenerationSupported = (): boolean => false;
	driver.__mcsCompatible = true;
};
