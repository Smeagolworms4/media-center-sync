import { describe, expect, it } from 'vitest';
import { useApiError } from '@/hooks/useApiError';

function options (fields: string[] = []) {
	return {
		fallback: 'error.general',
		mappedFields: new Set(fields),
	};
}

function jsonResponse (body: unknown, status = 400): Response {
	return Response.json(body, {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('useApiError', () => {
	const { parseApiError } = useApiError();

	it('maps a class-validator sentence onto the field it names', async () => {
		const parsed = await parseApiError(
			jsonResponse({
				statusCode: 400,
				message: ['username should not be empty', 'password must be longer than 8 characters'],
				error: 'Bad Request',
			}),
			options(['username', 'password']),
		);

		expect(parsed.mainError).toBeNull();
		expect(parsed.fieldErrors).toEqual({
			username: ['should not be empty'],
			password: ['must be longer than 8 characters'],
		});
	});

	it('keeps several messages for the same field', async () => {
		const parsed = await parseApiError(
			jsonResponse({
				statusCode: 400,
				message: ['password is too short', 'password must contain a digit'],
				error: 'Bad Request',
			}),
			options(['password']),
		);

		expect(parsed.fieldErrors.password).toEqual(['is too short', 'must contain a digit']);
	});

	it('matches a nested path on its leaf when the form is flat', async () => {
		const parsed = await parseApiError(
			jsonResponse({ statusCode: 400, message: ['filter.minYear must be an integer'], error: 'Bad Request' }),
			options(['minYear']),
		);

		expect(parsed.fieldErrors.minYear).toEqual(['must be an integer']);
	});

	it('prefers the full path when the form renders it as one control', async () => {
		const parsed = await parseApiError(
			jsonResponse({ statusCode: 400, message: ['filter.minYear must be an integer'], error: 'Bad Request' }),
			options(['filter.minYear', 'minYear']),
		);

		expect(parsed.fieldErrors['filter.minYear']).toEqual(['must be an integer']);
	});

	it('falls back to the main error for a field the form does not render', async () => {
		const parsed = await parseApiError(
			jsonResponse({ statusCode: 400, message: ['priority must be a number'], error: 'Bad Request' }),
			options(['name']),
		);

		expect(parsed.fieldErrors).toEqual({});
		expect(parsed.mainError).toBe('priority must be a number');
	});

	it('puts a refusal that names a field under that field', async () => {
		// The settings routes answer a key and the field it is about, because a screen
		// that saves twenty values at once cannot say "something was refused" and leave
		// somebody to guess which box.
		const parsed = await parseApiError(
			jsonResponse({ key: 'error.settings.public_url_invalid', field: 'publicUrl' }),
			options(['publicUrl', 'peerAddress']),
		);

		expect(parsed.mainError).toBeNull();
		expect(parsed.fieldErrors.publicUrl).toEqual([
			'Enter the full address, scheme included, such as https://mcs.example.org.',
		]);
	});

	it('raises it to the main error when the form does not render that field', async () => {
		const parsed = await parseApiError(
			jsonResponse({ key: 'error.settings.public_url_invalid', field: 'publicUrl' }),
			options(['peerAddress']),
		);

		expect(parsed.fieldErrors).toEqual({});
		expect(parsed.mainError).toContain('Enter the full address');
	});

	it('translates a business error key', async () => {
		const parsed = await parseApiError(
			jsonResponse({ statusCode: 401, message: 'error.auth.invalid_credentials', error: 'Unauthorized' }),
			options(['username']),
		);

		expect(parsed.mainError).toBe('Wrong username or password.');
		expect(parsed.fieldErrors).toEqual({});
	});

	it('degrades an unknown key to the fallback rather than showing it raw', async () => {
		const parsed = await parseApiError(
			jsonResponse({ statusCode: 500, message: 'error.something.nobody.translated', error: 'Internal' }),
			options(),
		);

		expect(parsed.mainError).toBe('Something went wrong. Try again in a moment.');
		expect(parsed.mainError).not.toContain('error.something');
	});

	it('degrades an unknown key inside a message array too', async () => {
		const parsed = await parseApiError(
			jsonResponse({ statusCode: 400, message: ['error.not.in.the.catalogue'], error: 'Bad Request' }),
			options(['username']),
		);

		expect(parsed.mainError).toBe('Something went wrong. Try again in a moment.');
	});

	it('uses a thrown Error message directly', async () => {
		const parsed = await parseApiError(new TypeError('Failed to fetch'), options());

		expect(parsed.mainError).toBe('Failed to fetch');
	});

	it('falls back when the body is not JSON', async () => {
		const parsed = await parseApiError(new Response('<html>502</html>', { status: 502 }), options());

		expect(parsed.mainError).toBe('Something went wrong. Try again in a moment.');
	});

	it('falls back on a payload with no message at all', async () => {
		const parsed = await parseApiError(jsonResponse({ statusCode: 500, error: 'Internal' }, 500), options());

		expect(parsed.mainError).toBe('Something went wrong. Try again in a moment.');
	});

	it('accepts an already-parsed payload object', async () => {
		const parsed = await parseApiError(
			{ statusCode: 409, message: 'error.service.duplicate', error: 'Conflict' },
			options(),
		);

		expect(parsed.mainError).toBe('This media service is already registered.');
	});

	it('translates a bare string payload that is a key', async () => {
		const parsed = await parseApiError(Response.json('error.peer.unreachable', {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		}), options());

		expect(parsed.mainError).toBe('The peer did not answer.');
	});

	it('falls back on something that is neither a payload nor an error', async () => {
		const parsed = await parseApiError(undefined, options());

		expect(parsed.mainError).toBe('Something went wrong. Try again in a moment.');
	});
});
