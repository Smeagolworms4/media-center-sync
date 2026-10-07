import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean } from 'class-validator';

/**
 * A boolean that may arrive as a word, which from a query string it always does.
 *
 * `?seasonPack=false` is the five characters `false`, and every obvious way of turning
 * that into a boolean is wrong in the same direction. `@Type(() => Boolean)` calls
 * `Boolean('false')`, which is **true** — so the field arrives as the opposite of what
 * the browser sent, validates cleanly, and the route does the other thing.
 *
 * That is not a hypothetical. The release search carried it: `seasonPack` was declared
 * with `@Type(() => Boolean)`, so every search for one episode arrived asking for the
 * whole season. The coordinate was then dropped — a season pack names no episode — and
 * `Futurama S11E10` went to the trackers as `Futurama S11`, which answers three hundred
 * rows for the wrong episode and ranks one of them first. Nothing failed, nothing logged,
 * and the screen showed a search that had plainly been run.
 *
 * So the conversion is written once, here, rather than inline at each field: the same
 * four lines were already copied into six declarations, and the seventh is where somebody
 * reached for `@Type` instead. Only the spellings a caller would mean are true — `true`,
 * `1`, and the boolean itself — and everything else, `false` included, is false.
 */
export const IsBooleanQuery = (): PropertyDecorator =>
	applyDecorators(
		/*
		 * Read off `obj`, which is the request as it arrived, and never off `value`.
		 *
		 * This is the half the inline copies got wrong, and it is why they looked right:
		 * the pipe runs with `enableImplicitConversion`, so by the time a transform is
		 * called, class-transformer has already turned `'false'` into a boolean using the
		 * declared type — `Boolean('false')`, which is true. A transform that reads `value`
		 * is handed that, agrees with it, and reports `false` as yes. It passed every test
		 * anybody wrote, because the tests all sent `true`.
		 *
		 * `obj[key]` is the untouched query string, so the conversion here is the only one
		 * that happens. An absent key stays absent: `undefined` is not an answer, and a
		 * search that never mentioned season packs is not a search that refused one.
		 */
		Transform(({ obj, key }) => {
			const raw = (obj as Record<string, unknown>)[key];

			return raw === undefined ? undefined : raw === true || raw === 'true' || raw === '1';
		}),
		IsBoolean(),
	);
