import {
	ErrorKey,
	NotificationEvent,
	type CreateNotificationChannelRequest,
	type NotificationChannel,
	type NotificationMessage,
	type NotificationTestResult,
	type UpdateNotificationChannelRequest,
} from '@mcs/shared';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { NotificationChannel as NotificationChannelEntity } from '@/entities';
import { NotificationChannelRepository } from '@/repositories';
import {
	NotificationRegistry,
	SettingsService,
	type NotificationContext,
} from '@/services';
import { toNotificationChannel } from './mappers';

/**
 * Who gets told what, and the promise that telling them can never cost anything.
 *
 * Two rules hold this file together and both are worth stating before reading it.
 *
 * The first is that **sending must never fail the thing it reports on**. `notify()`
 * returns a promise that resolves whatever happens: a mail server that refuses the
 * password, a topic that no longer exists, a DNS name that has gone — all of them end
 * as a line in `lastError` and nothing else. A notification that breaks a transfer is
 * strictly worse than no notification, and the call sites are in the middle of
 * planning runs and settling jobs where an exception would abort real work. It is
 * also why the callers do not await it.
 *
 * The second is that **a channel that fails silently is a channel nobody can trust**.
 * That is the entire reason `lastError` and `lastSentAt` exist on the row, and why
 * the test route answers what happened instead of throwing: somebody has to be able
 * to look at the settings screen and see that the thing has not delivered anything
 * since March.
 *
 * Nothing here knows how a channel actually talks to anybody. That belongs to the
 * handlers, which are the only things that know what their settings mean.
 */
@Injectable()
export class NotificationManager {
	private readonly _logger = new Logger(NotificationManager.name);

	public constructor(
		private readonly _channels: NotificationChannelRepository,
		private readonly _handlers: NotificationRegistry,
		private readonly _settings: SettingsService,
	) {}

	public async list(): Promise<NotificationChannel[]> {
		return (await this._channels.findAllOrdered()).map((channel) => this._present(channel));
	}

	public async read(id: string): Promise<NotificationChannel> {
		return this._present(await this._require(id));
	}

	/**
	 * Add a channel, refusing settings it could never work with.
	 *
	 * Validated before the row exists rather than on the first send. A channel saved
	 * with no topic looks configured on the settings screen and behaves exactly like
	 * one that is not — which is the failure this whole feature was built to remove,
	 * not to reproduce one level up.
	 */
	public async create(request: CreateNotificationChannelRequest): Promise<NotificationChannel> {
		const handler = this._handlers.get(request.type);

		handler.validate(request.config);

		const channel = await this._channels.save(
			this._channels.create({
				type: request.type,
				name: request.name,
				enabled: request.enabled ?? true,
				events: request.events ?? [],
				config: request.config,
				lastError: null,
				lastSentAt: null,
			}),
		);

		return this._present(channel);
	}

	/**
	 * Change a channel. A field that is not sent is not changed, secrets included.
	 *
	 * `config` is replaced by what is sent, except for the credentials it leaves out.
	 * That exception is not politeness, it is the only way this can work: the screen
	 * fills its form from the response, the response has had the secrets stripped out
	 * of it, and a plain replacement would therefore wipe the token every time
	 * somebody renamed a channel. A credential sent as an empty string is still
	 * cleared, so removing one is something the interface can offer.
	 */
	public async update(
		id: string,
		request: UpdateNotificationChannelRequest,
	): Promise<NotificationChannel> {
		const channel = await this._require(id);
		const type = request.type ?? channel.type;
		const handler = this._handlers.get(type);
		const config =
			request.config === undefined
				? channel.config
				: this._keepingSecrets(channel, request.config);

		handler.validate(config);

		channel.type = type;
		channel.name = request.name ?? channel.name;
		channel.enabled = request.enabled ?? channel.enabled;
		channel.events = request.events ?? channel.events;
		channel.config = config;

		return this._present(await this._channels.save(channel));
	}

	/**
	 * The incoming settings, plus the credentials they did not mention.
	 *
	 * Which keys count as credentials is asked of the handler that stored them — it
	 * is the only thing that knows — by taking the difference between the row and
	 * what that handler is willing to show. A second list of secret key names here
	 * would go out of date the first time a handler gained a field, and the failure
	 * would be a password silently dropped on an unrelated save.
	 *
	 * A channel whose type no longer has a handler keeps nothing: there is nothing
	 * that can say which of its keys were secret, and guessing would either leak one
	 * or drop one.
	 */
	private _keepingSecrets(
		channel: NotificationChannelEntity,
		incoming: Record<string, unknown>,
	): Record<string, unknown> {
		const handler = this._handlers.find(channel.type);

		if (!handler) {
			return incoming;
		}

		const shown = handler.redact(channel.config);
		const kept = Object.entries(channel.config).filter(
			([key]) => !(key in shown) && !(key in incoming),
		);

		return { ...Object.fromEntries(kept), ...incoming };
	}

	public async remove(id: string): Promise<void> {
		await this._channels.remove(await this._require(id));
	}

	/**
	 * Send one message now and say what happened.
	 *
	 * An answer rather than an exception, for the same reason a media service probe is
	 * one: a wrong password and an unreachable host are both ordinary results a form
	 * renders while somebody is still typing. The far end's own words come back
	 * because they are the diagnosis — "invalid access token", "550 sender not
	 * allowed" — and no key of ours could carry as much.
	 *
	 * It ignores `enabled` and the event list on purpose. Somebody pressing test on a
	 * channel they have just switched off is testing the settings, not the switch, and
	 * refusing them would read as the channel being broken.
	 */
	public async test(id: string): Promise<NotificationTestResult> {
		const channel = await this._require(id);
		const sentAt = new Date();

		try {
			await this._deliver(channel, {
				event: NotificationEvent.SYNC_FINISHED,
				title: 'Test notification',
				body: 'If you are reading this, this channel works.',
				link: '/settings',
			});
		} catch (cause) {
			const error = this._reason(cause);

			await this._channels.markFailed(channel.id, error);

			return { delivered: false, error, sentAt: null };
		}

		await this._channels.markSent(channel.id, sentAt);

		return { delivered: true, error: null, sentAt: sentAt.toISOString() };
	}

	/**
	 * Tell every channel that wants this event, and never let it cost the caller.
	 *
	 * The one entry point the rest of the application uses. It resolves rather than
	 * rejects under every circumstance — including a channel type this build has no
	 * handler for, which is what a downgrade looks like — because its callers are in
	 * the middle of planning a run or settling a job, and an exception there aborts
	 * real work over a message.
	 *
	 * Channels are delivered to in parallel and independently: a mail server that
	 * takes fifteen seconds to time out must not hold up the push that would have
	 * arrived instantly, and one failing channel must not stop the others.
	 */
	public async notify(message: NotificationMessage): Promise<void> {
		try {
			const channels = await this._channels.findEnabledFor(message.event);

			await Promise.all(channels.map((channel) => this._attempt(channel, message)));
		} catch (cause) {
			// Reaching here means the read itself failed — the database is gone, or the
			// table is not there yet. Logged and dropped: there is nothing useful to do
			// about it from inside a notification, and the caller is doing real work.
			this._logger.warn(`Could not dispatch ${message.event}: ${this._reason(cause)}`);
		}
	}

	/** One channel's attempt, with its outcome written where somebody can see it. */
	private async _attempt(
		channel: NotificationChannelEntity,
		message: NotificationMessage,
	): Promise<void> {
		try {
			await this._deliver(channel, message);
			await this._channels.markSent(channel.id);
		} catch (cause) {
			const error = this._reason(cause);

			this._logger.warn(`Channel "${channel.name}" failed on ${message.event}: ${error}`);

			// Best effort, and it has to be: if the row cannot be written the failure is
			// already logged, and throwing from here would defeat the whole promise this
			// method exists to keep.
			await this._channels.markFailed(channel.id, error).catch(() => undefined);
		}
	}

	private async _deliver(
		channel: NotificationChannelEntity,
		message: NotificationMessage,
	): Promise<void> {
		await this._handlers.get(channel.type).send(channel.config, message, await this._context());
	}

	/**
	 * What every handler needs and none of them should read for itself.
	 *
	 * The public URL is what turns a notification into something actionable, and it is
	 * a setting: a handler reaching for it would be a service deciding what a message
	 * is worth, which is not its layer.
	 */
	private async _context(): Promise<NotificationContext> {
		const settings = await this._settings.get();

		return { baseUrl: settings.publicUrl, instanceName: settings.instanceName };
	}

	/**
	 * The channel as it may be shown: its settings, minus its credentials.
	 *
	 * A channel whose type has no handler in this build still has to be listable —
	 * otherwise a gateway rolled back one version answers 404 for its whole settings
	 * screen — so it is presented with no settings at all rather than with settings
	 * nothing could redact.
	 */
	private _present(channel: NotificationChannelEntity): NotificationChannel {
		const handler = this._handlers.find(channel.type);

		return toNotificationChannel(channel, handler ? handler.redact(channel.config) : {});
	}

	private async _require(id: string): Promise<NotificationChannelEntity> {
		const channel = await this._channels.findOne({ where: { id } });

		if (channel === null) {
			throw new NotFoundException(ErrorKey.NOTIFICATION_CHANNEL_NOT_FOUND);
		}

		return channel;
	}

	/**
	 * A failure as a sentence somebody can read on the settings screen.
	 *
	 * Nest wraps its refusals in an object whose `message` is the useful part, and
	 * `String(error)` on one of those renders `[object Object]` — which is how a
	 * perfectly clear "topic is required" becomes a channel nobody can fix.
	 */
	private _reason(cause: unknown): string {
		if (cause instanceof Error) {
			return cause.message;
		}

		if (typeof cause === 'object' && cause !== null && 'message' in cause) {
			const { message } = cause as { message: unknown };

			return typeof message === 'string' ? message : JSON.stringify(message);
		}

		return String(cause);
	}
}
