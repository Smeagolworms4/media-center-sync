import {
	ErrorKey,
	ReleasePreferenceDimension,
	type ReleasePreferenceSettings,
	RequestSourceType,
} from '@mcs/shared';
import { ValidationPipe } from '@nestjs/common';
import { UpdateSettingsDto } from './settings.dto';

/**
 * What the settings route will and will not take.
 *
 * Driven through the real pipe, with the options `bootstrap.ts` installs, rather than by
 * calling a validator by hand. Two of the three things worth proving here only exist
 * because of those options: `whitelist` silently drops a key the DTO does not declare —
 * which is how a setting comes to look implemented everywhere except where it is used,
 * three times in this repository — and `enableImplicitConversion` rewrites nested values
 * on the way in, which has already turned a perfectly good list of mappings into a list
 * of empty arrays. Neither is visible to a test that validates an instance it built
 * itself.
 */
const pipe = new ValidationPipe({
	whitelist: true,
	forbidNonWhitelisted: true,
	transform: true,
	transformOptions: { enableImplicitConversion: true },
});

const through = (body: unknown): Promise<UpdateSettingsDto> =>
	pipe.transform(body, { type: 'body', metatype: UpdateSettingsDto }) as Promise<UpdateSettingsDto>;

const preferences = (over: Partial<ReleasePreferenceSettings> = {}): ReleasePreferenceSettings => ({
	global: { ranks: [{ dimension: ReleasePreferenceDimension.RESOLUTION, values: ['1080p'] }] },
	byCategory: {},
	...over,
});

const refusal = { key: ErrorKey.SETTINGS_INVALID, field: 'releasePreferences' };

describe('UpdateSettingsDto: the request source', () => {
	const source = {
		type: RequestSourceType.SEERR,
		baseUrl: 'http://jellyseerr:5055',
		enabled: true,
	};

	it('reaches the manager at all, rather than being stripped on the way in', async () => {
		// The whole point of declaring it: without the property the pipe drops the key,
		// the request answers 200, and the only symptom is a request list that stays
		// empty with nothing anywhere reporting a problem.
		const body = await through({ requestSource: source });

		expect(body.requestSource).toMatchObject(source);
	});

	it('takes a source with no key at all, which is how an address is edited', async () => {
		// An absent key means "keep the stored one" — the form cannot show what is
		// stored — so refusing this body would make the address unchangeable by anybody
		// who no longer has their key to hand.
		const body = await through({ requestSource: source });

		expect(body.requestSource?.apiKey).toBeUndefined();
	});

	it('carries a key that was typed, so it can be stored', async () => {
		const body = await through({ requestSource: { ...source, apiKey: 'secret' } });

		expect(body.requestSource?.apiKey).toBe('secret');
	});

	it('refuses a source of a kind this gateway cannot read', async () => {
		await expect(through({ requestSource: { ...source, type: 'sonarr' } })).rejects.toThrow();
	});

	it('takes null, which is the source being removed', async () => {
		const body = await through({ requestSource: null });

		expect(body.requestSource).toBeNull();
	});
});

describe('UpdateSettingsDto: the release preferences', () => {
	it('reaches the manager rather than being stripped on the way in', async () => {
		const body = await through({ releasePreferences: preferences() });

		expect(body.releasePreferences?.global.ranks[0]).toEqual({
			dimension: ReleasePreferenceDimension.RESOLUTION,
			values: ['1080p'],
		});
	});

	it('keeps the order of the dimensions, which is half of what the setting says', async () => {
		// Resolution before codec means resolution wins first, so 1080p x264 beats 720p
		// x265. A validator that sorted or folded the list would quietly say the opposite.
		const body = await through({
			releasePreferences: preferences({
				global: {
					ranks: [
						{ dimension: ReleasePreferenceDimension.CODEC, values: ['x265'] },
						{ dimension: ReleasePreferenceDimension.RESOLUTION, values: ['1080p'] },
					],
				},
			}),
		});

		expect(body.releasePreferences?.global.ranks.map((one) => one.dimension)).toEqual([
			ReleasePreferenceDimension.CODEC,
			ReleasePreferenceDimension.RESOLUTION,
		]);
	});

	it('takes an order that separates nothing, because that is a real answer', async () => {
		// A gateway nobody has configured: no opinion, so seeders and size still decide.
		const body = await through({ releasePreferences: { global: { ranks: [] }, byCategory: {} } });

		expect(body.releasePreferences?.global.ranks).toEqual([]);
	});

	it('takes a rank with no values, which is how a dimension is silenced', async () => {
		// Empty and absent are two different sentences: absent says "I have no override,
		// use the one above", and a rank with no values says "here, order by nothing" —
		// which is how one category opts out of a household order that is wrong for it.
		// See `isEmptyReleasePreference`. Refusing this makes that sentence unsayable.
		const body = await through({
			releasePreferences: preferences({
				byCategory: {
					films: { ranks: [{ dimension: ReleasePreferenceDimension.TEAM, values: [] }] },
				},
			}),
		});

		expect(body.releasePreferences?.byCategory.films.ranks[0].values).toEqual([]);
	});

	it('refuses a dimension nothing here knows how to read', async () => {
		// Stored, it would be a rank the comparator never consults and the screen shows
		// as a row that does nothing.
		await expect(
			through({
				releasePreferences: preferences({
					global: { ranks: [{ dimension: 'bitrate', values: ['high'] }] },
				} as unknown as Partial<ReleasePreferenceSettings>),
			}),
		).rejects.toMatchObject({ response: refusal });
	});

	it('refuses the same dimension twice in one order', async () => {
		// Not a stricter preference but an ambiguous one: the comparator takes the first
		// rank that separates two releases, so the second is dead weight — two rows on
		// screen disagreeing, one of them silently ignored.
		await expect(
			through({
				releasePreferences: preferences({
					global: {
						ranks: [
							{ dimension: ReleasePreferenceDimension.CODEC, values: ['x265'] },
							{ dimension: ReleasePreferenceDimension.CODEC, values: ['x264'] },
						],
					},
				}),
			}),
		).rejects.toMatchObject({ response: refusal });
	});

	it('refuses a value that is not a word somebody typed', async () => {
		await expect(
			through({
				releasePreferences: preferences({
					global: {
						ranks: [{ dimension: ReleasePreferenceDimension.CODEC, values: [{ x265: true }] }],
					},
				} as unknown as Partial<ReleasePreferenceSettings>),
			}),
		).rejects.toMatchObject({ response: refusal });
	});

	it('refuses a value far longer than any tag a tracker prints', async () => {
		await expect(
			through({
				releasePreferences: preferences({
					global: {
						ranks: [{ dimension: ReleasePreferenceDimension.TEAM, values: ['N'.repeat(500)] }],
					},
				}),
			}),
		).rejects.toMatchObject({ response: refusal });
	});

	it('refuses a list nobody could have meant', async () => {
		// The row is read whole on every search and folded value by value against every
		// release: a body carrying thousands of them would be accepted once and paid for
		// for ever, and no route removes a settings row.
		await expect(
			through({
				releasePreferences: preferences({
					global: {
						ranks: [{
							dimension: ReleasePreferenceDimension.TEAM,
							values: Array.from({ length: 5_000 }, (_, index) => `team-${index}`),
						}],
					},
				}),
			}),
		).rejects.toMatchObject({ response: refusal });
	});

	it('refuses half the setting, because the row is replaced and not merged', async () => {
		// Stored, `global` alone comes back with no `byCategory` — the shape guard on the
		// way out only asks whether it is still an object — and the first category lookup
		// of the next search throws.
		await expect(
			through({ releasePreferences: { global: { ranks: [] } } }),
		).rejects.toMatchObject({ response: refusal });
	});

	it('refuses a key the shape does not have, which would be stored verbatim', async () => {
		// `whitelist` stops at this property: a custom validator owns the whole subtree,
		// so anything not refused here is written into the row and read back for ever.
		await expect(
			through({ releasePreferences: { ...preferences(), colour: 'red' } }),
		).rejects.toMatchObject({ response: refusal });
	});

	it('refuses a table that is a list, since a category key is what addresses an override', async () => {
		await expect(
			through({ releasePreferences: { global: { ranks: [] }, byCategory: [] } }),
		).rejects.toMatchObject({ response: refusal });
	});
});
