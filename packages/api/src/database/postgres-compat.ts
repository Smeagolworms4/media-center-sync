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
 * The second adjustment is about identifiers. `@PrimaryGeneratedColumn('uuid')` lets
 * PostgreSQL produce the value through a column default, which is exactly what the
 * migration cannot create: `uuid_generate_v4()` does not exist on SQLite, so the
 * tables are created with plain `varchar(36)` primary keys on both engines. Telling
 * the driver it does not generate identifiers makes TypeORM produce them in the
 * application, as it already does on SQLite — the same rows, whichever engine is
 * behind them.
 *
 * Removing either line leaves a gateway that works on SQLite and fails on PostgreSQL
 * at the first insert, with an error that names the driver rather than this choice.
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

		return normalizeType.call(this, column);
	};

	driver.isUUIDGenerationSupported = (): boolean => false;
	driver.__mcsCompatible = true;
};
