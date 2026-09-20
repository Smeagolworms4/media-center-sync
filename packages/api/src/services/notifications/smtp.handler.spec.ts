import { NotificationEvent, type NotificationMessage } from '@mcs/shared';
import { BadRequestException } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import type { NotificationContext } from './notification-handler.interface';
import { SmtpHandler } from './smtp.handler';

/**
 * No socket is opened anywhere in this file.
 *
 * `nodemailer` is replaced wholesale rather than pointed at a local server: a test
 * that binds a port is a test that fails on a machine where something else already
 * has it, and one that reaches a real relay is one that eventually sends somebody an
 * email from a test run.
 */
jest.mock('nodemailer', () => ({
	createTransport: jest.fn(),
}));

const sendMail = jest.fn();
const close = jest.fn();
const createTransportMock = createTransport as unknown as jest.Mock;

const message: NotificationMessage = {
	event: NotificationEvent.DISK_FULL,
	title: 'Not enough space for this run',
	body: 'Movies: 40000000000 needed, 12000000000 free',
	link: '/settings',
};

const context: NotificationContext = {
	baseUrl: 'https://gateway.example',
	instanceName: 'Loft',
};

const CONFIG = {
	host: 'smtp.example',
	port: 587,
	username: 'gateway@example',
	password: 'hunter2',
	from: 'gateway@example',
	to: 'someone@example',
};

/** What `createTransport` was handed, and what `sendMail` was handed. */
const options = (): Record<string, unknown> =>
	createTransportMock.mock.calls[0][0] as Record<string, unknown>;
const mail = (): Record<string, unknown> => sendMail.mock.calls[0][0] as Record<string, unknown>;

describe('SmtpHandler', () => {
	const handler = new SmtpHandler();

	beforeEach(() => {
		sendMail.mockReset().mockResolvedValue({ messageId: 'id' });
		close.mockReset();
		createTransportMock.mockReset().mockReturnValue({ sendMail, close });
	});

	describe('settings it refuses, and the field it names', () => {
		it.each([
			['host', { from: 'a@b', to: 'c@d' }],
			['from', { host: 'smtp.example', to: 'c@d' }],
			['to', { host: 'smtp.example', from: 'a@b' }],
			['port', { host: 'smtp.example', from: 'a@b', to: 'c@d', port: 0 }],
			['port', { host: 'smtp.example', from: 'a@b', to: 'c@d', port: 'everywhere' }],
		])('names %s', (field, config) => {
			expect.assertions(2);

			try {
				handler.validate(config);
			} catch (error) {
				expect(error).toBeInstanceOf(BadRequestException);
				expect((error as BadRequestException).getResponse()).toMatchObject({ field });
			}
		});

		it('accepts a relay that wants no credentials at all', () => {
			// A mail server on the local network that relays for its own subnet is the
			// ordinary case in a household, and requiring a username would exclude it.
			expect(() =>
				handler.validate({ host: 'mail.lan', from: 'a@b', to: 'c@d' }),
			).not.toThrow();
		});

		it('takes a port typed into a text box as the number it is', () => {
			// A form model round-tripped through JSON hands back "587", and refusing it
			// would be refusing a port somebody typed correctly.
			expect(() =>
				handler.validate({ ...CONFIG, port: '465', secure: 'true' }),
			).not.toThrow();
		});
	});

	describe('how the connection is opened', () => {
		it('defaults to submission on 587 with STARTTLS', async () => {
			// 25 is refused by most providers and blocked outbound by many home ISPs,
			// which fails as a connection that hangs — a symptom that sends people
			// looking at their credentials instead.
			await handler.send({ host: 'smtp.example', from: 'a@b', to: 'c@d' }, message, context);

			expect(options()).toMatchObject({ port: 587, secure: false });
		});

		it('turns implicit TLS on by itself for 465', async () => {
			await handler.send({ ...CONFIG, port: 465 }, message, context);

			expect(options()).toMatchObject({ port: 465, secure: true });
		});

		it('lets an explicit choice override the port’s default', async () => {
			await handler.send({ ...CONFIG, port: 465, secure: false }, message, context);

			expect(options()).toMatchObject({ port: 465, secure: false });
		});

		it('offers no credentials when no username is configured', async () => {
			await handler.send({ host: 'mail.lan', from: 'a@b', to: 'c@d' }, message, context);

			expect(options().auth).toBeUndefined();
		});

		it('releases the socket even when the send failed', async () => {
			// A half-open connection keeps the Node event loop alive, and the API then
			// takes its full stop timeout to restart with nothing pointing here.
			sendMail.mockRejectedValue(new Error('550 sender not allowed'));

			await expect(handler.send(CONFIG, message, context)).rejects.toThrow(
				'550 sender not allowed',
			);

			expect(close).toHaveBeenCalledTimes(1);
		});
	});

	describe('what the message says', () => {
		it('names the gateway in the subject when one is set', async () => {
			await handler.send(CONFIG, message, context);

			expect(mail()).toMatchObject({
				from: CONFIG.from,
				to: CONFIG.to,
				subject: '[Loft] Not enough space for this run',
			});
		});

		it('leaves the subject alone on a gateway nobody has named', async () => {
			await handler.send(CONFIG, message, { baseUrl: null, instanceName: null });

			expect(mail().subject).toBe(message.title);
		});

		it('puts the link on its own line, absolute', async () => {
			await handler.send(CONFIG, message, context);

			expect(mail().text).toBe(`${message.body}\n\nhttps://gateway.example/settings`);
		});

		it('sends the text alone when the gateway has no public address', async () => {
			await handler.send(CONFIG, message, { baseUrl: null, instanceName: 'Loft' });

			expect(mail().text).toBe(message.body);
		});
	});

	describe('what may be shown', () => {
		it('drops the password and keeps what the form has to prefill', () => {
			expect(handler.redact(CONFIG)).toEqual({
				host: 'smtp.example',
				port: 587,
				username: 'gateway@example',
				from: 'gateway@example',
				to: 'someone@example',
			});
		});
	});
});
