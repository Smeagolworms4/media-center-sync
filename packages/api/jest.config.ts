import type { Config } from 'jest';

/**
 * Unit and functional tests live side by side.
 *
 * `src/**` holds the unit tests, next to what they cover: a manager is tested
 * against mocked repositories and services, so a test that fails names the rule
 * that broke rather than the stack underneath it.
 *
 * `test/**` holds the functional ones. They boot the real Nest application over an
 * in-memory SQLite database and talk to it through HTTP: they are what proves the
 * guards, the validation pipe and the serialisation actually apply — none of which
 * a unit test on a manager can see.
 */
const config: Config = {
	moduleFileExtensions: ['js', 'json', 'ts'],
	rootDir: '.',
	testRegex: '.*\\.spec\\.ts$',
	// Compiled with the whole program, never file by file (`isolatedModules`), and the
	// coverage thresholds are the reason. Compiled in isolation, TypeScript cannot tell
	// whether an injected constructor parameter's type is a class or only a type, so
	// every decorated constructor is emitted with a `typeof X !== "undefined" ? X :
	// Object` guard per parameter — branches that exist in no source file, whose second
	// half only runs on a broken circular import, and which Istanbul counts anyway. A
	// manager with six dependencies and nothing else to decide scored 77 % branches with
	// every line of its own tested, and the only ways to make that number pass were a
	// test proving nothing or an ignore comment. With the program, the guard is not
	// emitted and the count is the source's. The price is type-checking while
	// transforming: a run is a few seconds slower, and a type error in a test fails it.
	transform: {
		'^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
	},
	moduleNameMapper: {
		'^@/(.*)$': '<rootDir>/src/$1',
	},
	collectCoverageFrom: [
		'src/**/*.ts',
		'!src/**/index.ts',
		'!src/main.ts',
		'!src/commands/**',
		'!src/database/migrations/**',
	],
	coverageDirectory: 'coverage',
	coverageReporters: ['text', 'lcov', 'cobertura'],
	// The layers that hold decisions are held to a high bar; the wiring is covered
	// by the functional tests rather than by counting its lines.
	coverageThreshold: {
		global: { statements: 80, branches: 70, functions: 80, lines: 80 },
		'src/managers/**/*.ts': { statements: 90, branches: 80, functions: 90, lines: 90 },
	},
	reporters: ['default', ['jest-junit', { outputName: 'junit.xml' }]],
	testEnvironment: 'node',
	setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
};

export default config;
