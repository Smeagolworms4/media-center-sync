/*
 * A thread that does nothing but read. Read `ReadPoolService` first: this is the other
 * end of it.
 *
 * No TypeORM, no entities, no `reflect-metadata` — unlike `jobs.worker.ts`, which builds
 * repositories and therefore needs the decorator shim. This one is handed finished SQL
 * and hands back rows, so the heaviest thing it loads is the driver itself. That matters
 * on a NAS: a reader costs a connection and a few megabytes, which is what makes it
 * affordable to run two of them.
 */
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
// By path rather than through the barrel: this file deliberately loads no TypeORM, and
// the barrel would bring the entities and the migrations with it.
import { CONNECTION_PRAGMAS } from '@/database/pragmas';

/**
 * The slice of `better-sqlite3` this file uses, declared rather than installed.
 *
 * The driver ships no types and the gateway does not depend on `@types/better-sqlite3`
 * anywhere else — TypeORM owns the connection everywhere except here. Three methods is
 * a smaller thing to keep correct than a dependency whose version has to be kept in
 * step with the driver's, and a mistake in it fails at the first read rather than
 * silently.
 */
interface Statement {
	all(...params: unknown[]): unknown[];
}

interface Connection {
	prepare(sql: string): Statement;
	pragma(source: string): unknown;
}

type DatabaseConstructor = new (
	file: string,
	options: { fileMustExist: boolean; readonly: boolean },
) => Connection;

// `createRequire` rather than an `import`: this file is loaded both as compiled
// JavaScript and, in development, through ts-node, and the driver is CommonJS.
const Database = createRequire(__filename)('better-sqlite3') as DatabaseConstructor;

/**
 * How many prepared statements to keep.
 *
 * A listing re-runs the same handful of statements with different parameters, so the
 * cache hits almost always and `prepare` — which parses and plans — happens once per
 * shape rather than once per request. Bounded because the keys are SQL strings built by
 * a query builder: a filter combination nobody uses again would otherwise be held
 * forever.
 */
const STATEMENT_CACHE = 64;

interface ReadRequest {
	id: string;
	sql: string;
	params: unknown[];
}

interface ReadAnswer {
	id: string;
	rows?: unknown[];
	error?: string;
}

const { file } = workerData as { file: string };

/*
 * Read-only, and that is a guarantee rather than a precaution.
 *
 * This thread exists to take listings off the gateway's thread. If a mistake upstream
 * ever sent it an `UPDATE`, SQLite refuses it here instead of writing from a connection
 * nothing else knows about — which is the kind of bug that shows up weeks later as rows
 * that no transaction in the code can account for.
 */
const db = new Database(file, { fileMustExist: true, readonly: true });

/*
 * WAL is set by the gateway's own connection and is a property of the file, so there is
 * nothing to set here — but every one of these is per connection, and this thread now
 * serves most of the gateway's reads. A reader with SQLite's default two-megabyte page
 * cache, sorting its scope into a temporary file on the card, is the deployment the
 * owner measured at 2.5 GB read and 1.4 GB written in under an hour. See `pragmas.ts`.
 */
for (const pragma of CONNECTION_PRAGMAS) {
	db.pragma(pragma);
}

const statements = new Map<string, Statement>();

const prepared = (sql: string): Statement => {
	const known = statements.get(sql);

	if (known !== undefined) {
		return known;
	}

	if (statements.size >= STATEMENT_CACHE) {
		// Oldest first: a `Map` keeps insertion order, and the statement least recently
		// *added* is a good enough approximation of the one least worth keeping.
		const oldest = statements.keys().next();

		if (!oldest.done) {
			statements.delete(oldest.value);
		}
	}

	const statement = db.prepare(sql);

	statements.set(sql, statement);

	return statement;
};

const say = (answer: ReadAnswer): void => {
	parentPort?.postMessage(answer);
};

parentPort?.on('message', (request: ReadRequest) => {
	try {
		say({ id: request.id, rows: prepared(request.sql).all(...request.params) });
	} catch (error) {
		// The message rather than the error, because an `Error` does not survive the
		// structured clone with its stack and the caller only needs to know what to log
		// before falling back to reading on its own thread.
		say({ id: request.id, error: error instanceof Error ? error.message : String(error) });
	}
});
