import { ValidationPipe } from '@nestjs/common';
import { IsOptional } from 'class-validator';
import { IsBooleanQuery } from './boolean-query.decorator';

class Query {
	@IsOptional()
	@IsBooleanQuery()
	public flag?: boolean;
}

/**
 * The real pipe, with the real options — see `bootstrap.ts`.
 *
 * Built here rather than faked because the defect this file exists for lived in the
 * conversion, not in the decorator: a hand-rolled transform would have agreed with
 * whatever the test expected, and the question is what Nest does to `?flag=false` on the
 * way in.
 */
const pipe = new ValidationPipe({
	whitelist: true,
	forbidNonWhitelisted: true,
	transform: true,
	transformOptions: { enableImplicitConversion: true },
});

const through = async <T>(type: new () => T, value: Record<string, unknown>): Promise<T> =>
	(await pipe.transform(value, { type: 'query', metatype: type })) as T;

describe('a boolean that arrives as a word', () => {
	it.each([
		['false', false],
		['0', false],
		['', false],
		['no', false],
		['true', true],
		['1', true],
	])('reads ?flag=%s as %s', async (sent, expected) => {
		/*
		 * `false` is the one that mattered and the one every obvious conversion gets
		 * wrong: `Boolean('false')` is true, so the field arrives as the opposite of what
		 * was sent, validates cleanly, and the route does the other thing.
		 */
		await expect(through(Query, { flag: sent })).resolves.toMatchObject({ flag: expected });
	});

	it('leaves an absent flag absent, rather than reading it as no', async () => {
		// Absent and false are different answers everywhere this is used: a search that
		// never mentioned season packs is not a search that refused one.
		await expect(through(Query, {})).resolves.not.toHaveProperty('flag');
	});

});
