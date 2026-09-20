import { ErrorKey } from '@mcs/shared';
import { BadRequestException } from '@nestjs/common';

/**
 * Reading a channel's opaque settings, and refusing them by name.
 *
 * `config` is `Record<string, unknown>` on purpose — widening it into a union would
 * make every screen that imports the contract grow a case per channel type — which
 * leaves each handler with the same three questions to ask of untyped values. Asked
 * here once so that all of them refuse the same way: with `{ key, field }`, which is
 * the shape the interface puts under the matching input rather than above the form.
 */

/** Refusal carrying the field, which is the only part somebody can act on. */
export const refuseField = (field: string): never => {
	throw new BadRequestException({ key: ErrorKey.NOTIFICATION_CONFIG_INVALID, field });
};

/**
 * A non-empty string, trimmed.
 *
 * Trimmed because a topic or a host pasted out of a chat message carries a trailing
 * space often enough, and `https://ntfy.sh ` fails at the socket with a message about
 * a name that does not resolve rather than about the space nobody can see.
 */
export const requireString = (
	config: Record<string, unknown>,
	field: string,
): string => {
	const value = config[field];

	if (typeof value !== 'string' || value.trim() === '') {
		return refuseField(field);
	}

	return value.trim();
};

/** Null rather than a refusal when the key is absent, for the optional half. */
export const optionalString = (
	config: Record<string, unknown>,
	field: string,
): string | null => {
	const value = config[field];

	if (value === undefined || value === null || value === '') {
		return null;
	}

	if (typeof value !== 'string') {
		return refuseField(field);
	}

	const trimmed = value.trim();

	return trimmed === '' ? null : trimmed;
};

/**
 * A port, whether it arrived as a number or as the string a form control produces.
 *
 * Accepting the string is not laxity: a `v-text-field` bound to a JSON object hands
 * back `"587"`, and a channel refused for a port somebody typed correctly is the kind
 * of refusal that gets the whole feature blamed.
 */
export const requirePort = (
	config: Record<string, unknown>,
	field: string,
	fallback: number,
): number => {
	const value = config[field];

	if (value === undefined || value === null || value === '') {
		return fallback;
	}

	const port = Number(value);

	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		return refuseField(field);
	}

	return port;
};

export const optionalBoolean = (
	config: Record<string, unknown>,
	field: string,
	fallback: boolean,
): boolean => {
	const value = config[field];

	if (value === undefined || value === null || value === '') {
		return fallback;
	}

	if (typeof value === 'boolean') {
		return value;
	}

	// Same reason as the port: a checkbox round-tripped through JSON in a form model
	// can arrive as a string, and refusing it would be refusing a box somebody ticked.
	if (value === 'true' || value === 'false') {
		return value === 'true';
	}

	return refuseField(field);
};

/**
 * Everything but the named keys.
 *
 * The one place redaction is implemented, so that a handler declares which of its
 * settings are credentials and never how to hide them — two handlers spelling this
 * out is two chances to spell it out wrongly, and the failure is a token in a
 * response nobody reads closely.
 */
export const withoutKeys = (
	config: Record<string, unknown>,
	secrets: readonly string[],
): Record<string, unknown> =>
	Object.fromEntries(Object.entries(config).filter(([key]) => !secrets.includes(key)));
