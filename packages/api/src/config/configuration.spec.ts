import { configuration } from './configuration';

describe('configuration', () => {
	const original = { ...process.env };

	afterEach(() => {
		process.env = { ...original };
	});

	it('falls back to the development defaults', () => {
		delete process.env.API_PORT;
		delete process.env.DB_TYPE;
		delete process.env.DB_FILE;
		delete process.env.MCS_MEDIA_ROOT;
		delete process.env.MCS_TRANSFER_ROOT;
		process.env.NODE_ENV = 'development';

		const config = configuration();

		expect(config.port).toBe(4200);
		expect(config.prefix).toBe('api');
		expect(config.database.type).toBe('sqlite');
		expect(config.database.file).toBe('var/media-center-sync.db');
		expect(config.media.root).toBe('/media');
		expect(config.media.transferRoot).toBe('var/transfer');
		expect(config.security.bcryptRounds).toBe(12);
	});

	it('reads the engine and its connection details', () => {
		process.env.DB_TYPE = 'postgres';
		process.env.DB_HOST = 'db';
		process.env.DB_PORT = '5432';
		process.env.DB_NAME = 'gateway';

		const config = configuration();

		expect(config.database).toMatchObject({ type: 'postgres', host: 'db', port: 5432, name: 'gateway' });
	});

	it('treats an unknown engine as sqlite rather than passing it through', () => {
		process.env.DB_TYPE = 'mysql';

		expect(configuration().database.type).toBe('sqlite');
	});

	it('refuses to start in production without a signing secret', () => {
		process.env.NODE_ENV = 'production';
		delete process.env.MCS_JWT_SECRET;

		expect(() => configuration()).toThrow(/MCS_JWT_SECRET/);
	});

	it('starts in production once the secret is given', () => {
		process.env.NODE_ENV = 'production';
		process.env.MCS_JWT_SECRET = 'a-real-secret';

		expect(configuration().security.jwtSecret).toBe('a-real-secret');
	});

	it('keeps a development default so a fresh clone starts', () => {
		process.env.NODE_ENV = 'development';
		delete process.env.MCS_JWT_SECRET;

		expect(configuration().security.jwtSecret).not.toBe('');
	});

	it('hides the documentation in production unless it is asked for', () => {
		process.env.NODE_ENV = 'production';
		process.env.MCS_JWT_SECRET = 'a-real-secret';
		delete process.env.MCS_DOCS;

		expect(configuration().docs.enabled).toBe(false);

		process.env.MCS_DOCS = '1';

		expect(configuration().docs.enabled).toBe(true);
	});

	it('splits the allowed origins and drops the empty ones', () => {
		process.env.MCS_CORS_ORIGINS = 'http://a.test, http://b.test ,';

		expect(configuration().corsOrigins).toEqual(['http://a.test', 'http://b.test']);
	});

	it('answers an empty list when no origin is configured', () => {
		delete process.env.MCS_CORS_ORIGINS;

		expect(configuration().corsOrigins).toEqual([]);
	});

	it('ignores a port that is not a number', () => {
		process.env.API_PORT = 'not-a-port';

		expect(configuration().port).toBe(4200);
	});

	it('is frozen, so nothing can rewrite it after startup', () => {
		const config = configuration();

		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.isFrozen(config.security)).toBe(true);
	});
});
