import { NotificationChannelType, type NotificationMessage } from '@mcs/shared';
import { Injectable } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { NotificationHandler } from './notification.decorator';
import {
	optionalBoolean,
	optionalString,
	requirePort,
	requireString,
	withoutKeys,
} from './notification.config';
import type {
	NotificationChannelHandler,
	NotificationContext,
} from './notification-handler.interface';

/**
 * Submission, not SMTP.
 *
 * 587 with STARTTLS is what every provider actually accepts from something that is
 * not a mail server; 25 is refused by most of them and blocked outbound by a good
 * number of home ISPs, which fails as a connection that hangs and then times out —
 * a symptom that sends people looking at their credentials.
 */
const DEFAULT_PORT = 587;

/** Implicit TLS lives on 465 and is the only port where `secure` defaults true. */
const IMPLICIT_TLS_PORT = 465;

/**
 * Long enough for a provider that greylists a first connection, short enough that a
 * host which is simply unreachable answers the settings screen rather than leaving it
 * spinning. Nothing waits on a notification, so patience buys nothing here.
 */
const SMTP_TIMEOUT_MS = 15_000;

const SECRET_KEYS = ['password'] as const;

/**
 * An ordinary email.
 *
 * Slower and heavier than a push, and kept because it reaches whatever already
 * notifies somebody — and because it survives what push does not: a phone that
 * changed, an account that moved, a household that reads one shared mailbox.
 *
 * The transport is built per message rather than pooled. A pooled connection would
 * save a handshake on a channel that sends a few messages a day, and would cost a
 * socket held open to somebody's mail provider for the life of the process, plus a
 * cache to invalidate the moment the password is changed on the settings screen —
 * which is precisely when a stale pooled connection would keep working and make the
 * change look applied.
 */
@Injectable()
@NotificationHandler(NotificationChannelType.SMTP)
export class SmtpHandler implements NotificationChannelHandler {
	public readonly type = NotificationChannelType.SMTP;

	public validate(config: Record<string, unknown>): void {
		this._settings(config);
	}

	public redact(config: Record<string, unknown>): Record<string, unknown> {
		return withoutKeys(config, SECRET_KEYS);
	}

	public async send(
		config: Record<string, unknown>,
		message: NotificationMessage,
		context: NotificationContext,
	): Promise<void> {
		const settings = this._settings(config);

		const transport = createTransport({
			host: settings.host,
			port: settings.port,
			secure: settings.secure,
			auth:
				settings.username === null
					? undefined
					: { user: settings.username, pass: settings.password ?? '' },
			connectionTimeout: SMTP_TIMEOUT_MS,
			greetingTimeout: SMTP_TIMEOUT_MS,
			socketTimeout: SMTP_TIMEOUT_MS,
		});

		try {
			await transport.sendMail({
				from: settings.from,
				to: settings.to,
				subject: context.instanceName
					? `[${context.instanceName}] ${message.title}`
					: message.title,
				text: this._text(message, context),
			});
		} finally {
			// Releases the socket whether the send worked or not. Without it a failed
			// send leaves a half-open connection that keeps the Node event loop alive,
			// and the API stops exiting cleanly — which surfaces as a container that
			// takes its full stop timeout to restart, with nothing pointing here.
			transport.close();
		}
	}

	/**
	 * One reading of the settings, used by both validation and sending.
	 *
	 * Split in two, a channel would be accepted against one set of keys and fail
	 * every message against another — the silent channel this feature exists to make
	 * impossible.
	 */
	private _settings(config: Record<string, unknown>): {
		host: string;
		port: number;
		secure: boolean;
		username: string | null;
		password: string | null;
		from: string;
		to: string;
	} {
		const port = requirePort(config, 'port', DEFAULT_PORT);

		return {
			host: requireString(config, 'host'),
			port,
			// Defaulted from the port rather than from a fixed value: 465 speaks TLS
			// from the first byte and 587 upgrades with STARTTLS, and getting that pair
			// the wrong way round fails with a timeout or with a protocol error that
			// mentions neither TLS nor the port.
			secure: optionalBoolean(config, 'secure', port === IMPLICIT_TLS_PORT),
			username: optionalString(config, 'username'),
			password: optionalString(config, 'password'),
			// Required, and not defaulted to the username: a relay that accepts the
			// login and refuses the envelope sender answers "550 sender not allowed",
			// which reads as a credential problem and is not one.
			from: requireString(config, 'from'),
			to: requireString(config, 'to'),
		};
	}

	/**
	 * Plain text, with the link on its own line.
	 *
	 * No HTML part: everything here is two sentences and a URL, and an HTML body
	 * would buy nothing except a second thing to escape somebody else's media titles
	 * into.
	 */
	private _text(message: NotificationMessage, context: NotificationContext): string {
		const lines = [message.body];

		if (message.link !== null && context.baseUrl !== null) {
			lines.push(
				'',
				`${context.baseUrl.replace(/\/+$/, '')}${message.link.startsWith('/') ? '' : '/'}${message.link}`,
			);
		}

		return lines.join('\n');
	}
}
