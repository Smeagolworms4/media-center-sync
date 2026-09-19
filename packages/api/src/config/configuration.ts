/**
 * The whole configuration of the gateway, read once from the environment.
 *
 * Nothing else in the application reads `process.env`: a value that is only ever
 * resolved here can be defaulted, validated and typed in one place, and a missing
 * variable fails at startup rather than three hours into a transfer.
 */

export type DatabaseType = 'sqlite' | 'postgres';

export interface DatabaseConfig {
	type: DatabaseType;
	/** SQLite only: path of the database file, relative to the repository root. */
	file: string;
	host: string;
	port: number;
	name: string;
	user: string;
	password: string;
	/**
	 * Bring the schema up to date when the application starts.
	 *
	 * On by default, because the alternative is telling somebody who just pulled a
	 * container to exec into it before it will serve anything. Turn it off where a
	 * deployment applies migrations as its own step and wants to know exactly when.
	 */
	migrateOnStart: boolean;
}

export interface CacheConfig {
	/** Empty means the in-process cache: a single gateway needs nothing more. */
	redisHost: string;
	redisPort: number;
}

export interface SecurityConfig {
	jwtSecret: string;
	accessTtl: string;
	refreshTtl: string;
	bcryptRounds: number;
}

export interface MediaConfig {
	/** Root under which the libraries are mounted, as the gateway sees them. */
	root: string;
	/** Where incomplete transfers accumulate before they are placed. */
	transferRoot: string;
}

export interface DocsConfig {
	enabled: boolean;
}

export interface AppConfig {
	env: string;
	port: number;
	prefix: string;
	peerPort: number;
	database: DatabaseConfig;
	cache: CacheConfig;
	security: SecurityConfig;
	media: MediaConfig;
	/** Directory of the built interface. Empty serves nothing but the API. */
	staticRoot: string;
	docs: DocsConfig;
	corsOrigins: string[];
	version: string;
}

const readString = (name: string, fallback: string): string => {
	const value = process.env[name];

	return value === undefined || value === '' ? fallback : value;
};

/**
 * A flag from the environment, where everything is a string.
 *
 * `0`, `false`, `no` and `off` are all ways people say no in a compose file, and one
 * that silently means yes is a setting somebody turns off and watches keep happening.
 */
const readBoolean = (name: string, fallback: boolean): boolean => {
	const value = process.env[name];

	if (value === undefined || value === '') {
		return fallback;
	}

	return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
};

const readNumber = (name: string, fallback: number): number => {
	const value = Number(process.env[name]);

	return Number.isFinite(value) && process.env[name] !== undefined && process.env[name] !== ''
		? value
		: fallback;
};

/**
 * The signing secret, refused by default in production.
 *
 * A built-in fallback would be published with the repository, and anyone who read it
 * could mint a token for any account of any gateway running the image. There is no
 * safe default, so production has no default at all — while development keeps one,
 * because asking for a secret before the first `make init` only teaches people to
 * paste the same string everywhere.
 */
const readJwtSecret = (production: boolean): string => {
	const secret = process.env.MCS_JWT_SECRET;

	if (secret !== undefined && secret !== '') {
		return secret;
	}

	if (production) {
		throw new Error(
			'MCS_JWT_SECRET is required in production: sessions cannot be signed with a published default.',
		);
	}

	return 'development-secret-not-for-production';
};

export const configuration = (): AppConfig => {
	const env = readString('NODE_ENV', 'development');
	const production = env === 'production';
	const databaseType: DatabaseType = readString('DB_TYPE', 'sqlite') === 'postgres'
		? 'postgres'
		: 'sqlite';

	return Object.freeze({
		env,
		port: readNumber('API_PORT', 4200),
		prefix: 'api',
		peerPort: readNumber('PEER_PORT', 4210),
		database: Object.freeze({
			type: databaseType,
			file: readString('DB_FILE', 'var/media-center-sync.db'),
			host: readString('DB_HOST', 'localhost'),
			port: readNumber('DB_PORT', 5432),
			name: readString('DB_NAME', 'mcs'),
			user: readString('DB_USER', 'mcs'),
			password: readString('DB_PASSWORD', 'mcs'),
			migrateOnStart: readBoolean('DB_MIGRATE_ON_START', true),
		}),
		cache: Object.freeze({
			redisHost: readString('REDIS_HOST', ''),
			redisPort: readNumber('REDIS_PORT', 6379),
		}),
		security: Object.freeze({
			jwtSecret: readJwtSecret(production),
			accessTtl: readString('MCS_ACCESS_TTL', '15m'),
			refreshTtl: readString('MCS_REFRESH_TTL', '30d'),
			bcryptRounds: readNumber('MCS_BCRYPT_ROUNDS', 12),
		}),
		media: Object.freeze({
			root: readString('MCS_MEDIA_ROOT', '/media'),
			transferRoot: readString('MCS_TRANSFER_ROOT', 'var/transfer'),
		}),
		staticRoot: readString('MCS_STATIC_ROOT', ''),
		docs: Object.freeze({
			// Swagger describes every route, including the ones an attacker would
			// rather not have to guess. It stays on everywhere but production, where
			// it has to be asked for.
			enabled: !production || process.env.MCS_DOCS === '1',
		}),
		corsOrigins: Object.freeze(
			readString('MCS_CORS_ORIGINS', '')
				.split(',')
				.map((origin) => origin.trim())
				.filter((origin) => origin !== ''),
		) as string[],
		version: readString('MCS_VERSION', 'dev'),
	});
};
