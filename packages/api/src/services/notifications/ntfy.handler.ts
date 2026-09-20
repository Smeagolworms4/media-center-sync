import { NotificationChannelType, type NotificationMessage } from '@mcs/shared';
import { Injectable } from '@nestjs/common';
import { NotificationHandler } from './notification.decorator';
import { optionalString, requireString, withoutKeys } from './notification.config';
import type {
	NotificationChannelHandler,
	NotificationContext,
} from './notification-handler.interface';

/**
 * How long one publish is given before it is called a failure.
 *
 * Short on purpose. Nothing waits on a notification — the transfer it reports on has
 * already happened — so a server that has gone away must cost the caller a few
 * seconds, not the thirty a default socket timeout would spend before anybody finds
 * out. The test route is the same request, and a settings screen that hangs for half
 * a minute reads as broken rather than as slow.
 */
const NTFY_TIMEOUT_MS = 10_000;

/** The token is the only credential here, and it never leaves in a response. */
const SECRET_KEYS = ['token'] as const;

/**
 * A push to an ntfy topic.
 *
 * The right default for a phone, and the reason is worth keeping in view: there is no
 * account, no application of ours to write and publish, and no credential worth
 * stealing — a URL and a topic name. A household publishes to a topic only they know
 * and every phone subscribed to it buzzes.
 *
 * That last part is also its one real weakness, and it is a deliberate trade rather
 * than an oversight: on a public server a topic is a shared secret and nothing more,
 * so anybody who learns the name receives the messages. Which is exactly why the body
 * carries what happened and never what would let somebody act on this gateway.
 */
@Injectable()
@NotificationHandler(NotificationChannelType.NTFY)
export class NtfyHandler implements NotificationChannelHandler {
	public readonly type = NotificationChannelType.NTFY;

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
		const link = this._link(message, context);

		const headers: Record<string, string> = {
			// ntfy reads the title, the tag and the click target from headers rather
			// than from the body, and a header carrying a newline or a non-ASCII byte
			// is rejected by `fetch` before it is sent. Titles come from media
			// metadata, so accented characters are the normal case, not the odd one.
			Title: this._headerSafe(this._title(message, context)),
			Tags: message.event,
			'Content-Type': 'text/plain; charset=utf-8',
		};

		if (settings.token !== null) {
			headers.Authorization = `Bearer ${settings.token}`;
		}

		if (link !== null) {
			headers.Click = link;
		}

		const response = await fetch(`${settings.url}/${settings.topic}`, {
			method: 'POST',
			headers,
			body: message.body,
			signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
		});

		if (!response.ok) {
			// The server's own words, not a key of ours. ntfy answers "topic is
			// reserved" and "invalid access token" in plain text, and those two
			// sentences are the whole diagnosis — no key we could invent would say as
			// much, and this string is going straight into `lastError` for somebody to
			// read on the settings screen.
			throw new Error(
				`${response.status} ${response.statusText}: ${(await response.text().catch(() => '')).trim()}`.trim(),
			);
		}
	}

	/**
	 * The one place the settings are read, so validation and sending cannot drift.
	 *
	 * A handler that checked one set of keys on save and used another on send would
	 * accept a channel and then fail every message on it, which is the failure this
	 * whole feature exists to make visible rather than to reproduce.
	 */
	private _settings(config: Record<string, unknown>): {
		url: string;
		topic: string;
		token: string | null;
	} {
		const url = requireString(config, 'url');
		const topic = requireString(config, 'topic');

		return {
			// Trailing slashes are stripped rather than refused: people paste
			// `https://ntfy.sh/` as often as not, and a publish to `https://ntfy.sh//home`
			// is a 404 that says nothing about the extra character.
			url: url.replace(/\/+$/, ''),
			topic,
			token: optionalString(config, 'token'),
		};
	}

	/**
	 * Names the gateway when there are two of them on one topic.
	 *
	 * Bracketed with plain ASCII, the same way the mail subject is. An em dash reads
	 * better and would push every titled message through the encoding below, which
	 * only the clients that decode RFC 2047 would render — the rest would show the
	 * `=?UTF-8?B?…?=` itself.
	 */
	private _title(message: NotificationMessage, context: NotificationContext): string {
		return context.instanceName ? `[${context.instanceName}] ${message.title}` : message.title;
	}

	/**
	 * Where to go to act on it, absolute, or nothing at all.
	 *
	 * A relative path is useless in a push: the phone that receives it has no idea
	 * which gateway sent it. And a link built on `localhost` would be correct on
	 * exactly one machine and wrong on every phone, so no public URL means no link
	 * rather than a broken one.
	 */
	private _link(message: NotificationMessage, context: NotificationContext): string | null {
		if (message.link === null || context.baseUrl === null) {
			return null;
		}

		return `${context.baseUrl.replace(/\/+$/, '')}${message.link.startsWith('/') ? '' : '/'}${message.link}`;
	}

	/**
	 * A header value `fetch` will actually send.
	 *
	 * Undici refuses a header carrying a newline or a byte above 0xFF with a
	 * `TypeError` about an invalid value, naming neither the header nor the character
	 * — and every title here comes from somebody else's media metadata. Non-ASCII is
	 * encoded the way RFC 2047 says so accents survive on the clients that decode it,
	 * and newlines simply become spaces: a title is one line by definition.
	 */
	private _headerSafe(value: string): string {
		const flattened = value.replaceAll(/[\r\n]+/g, ' ').trim();

		if (/^[ -~]*$/.test(flattened)) {
			return flattened;
		}

		return `=?UTF-8?B?${Buffer.from(flattened, 'utf8').toString('base64')}?=`;
	}
}
