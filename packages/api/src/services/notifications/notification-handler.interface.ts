import type {
	NotificationChannelType,
	NotificationMessage,
} from '@mcs/shared';

/**
 * Everything a handler needs that is not in the channel's own settings.
 *
 * `baseUrl` is the gateway's public address, and it is what turns a notification into
 * something somebody can act on: a message that says a pull landed in the wrong
 * folder and gives no way of opening the screen that fixes it is a message people
 * learn to ignore. Null when nobody has set the public URL, in which case a handler
 * sends the text and no link rather than a link to `localhost`, which would be
 * correct on exactly one machine and wrong on the phone the message went to.
 */
export interface NotificationContext {
	baseUrl: string | null;
	/** Names this gateway in the message, for a household that runs two of them. */
	instanceName: string | null;
}

/**
 * The contract every way of notifying somebody speaks through.
 *
 * Adding a third — a webhook, a matrix room, a push service — means writing one class
 * implementing this and decorating it with `@NotificationHandler`; nothing else in
 * the application knows the difference. Handlers are stateless singletons and the
 * channel's settings travel as an argument, exactly as a media handler's connection
 * does: a gateway with three ntfy topics has one ntfy handler, not three.
 */
export interface NotificationChannelHandler {
	readonly type: NotificationChannelType;

	/**
	 * Refuse settings this channel cannot work with, naming the field.
	 *
	 * The handler is the only place that knows what it requires — that is the whole
	 * reason `config` is opaque everywhere else — so it is also the only place that
	 * can say which box is empty. Throwing a refusal that names no field leaves
	 * somebody staring at six inputs, and the one being complained about is the one
	 * they have never heard of.
	 */
	validate(config: Record<string, unknown>): void;

	/**
	 * The settings as they may be shown, which is never all of them.
	 *
	 * A token or a mailbox password that leaves through a list endpoint is a
	 * credential somebody else now has, and nothing in the response would say so. The
	 * secret keys are dropped rather than blanked, for the reason `toMediaService`
	 * gives about the token: a field that exists and happens to be empty is one
	 * refactor away from being filled in again.
	 */
	redact(config: Record<string, unknown>): Record<string, unknown>;

	/**
	 * Deliver one message, or throw with what the far end said.
	 *
	 * Throwing is right here and only here: the caller is the manager, which catches
	 * everything and writes it to `lastError`. What must never happen is a handler
	 * swallowing a failure — a channel that fails silently is a channel nobody can
	 * trust, and the row is the only place that can say it has gone quiet.
	 */
	send(
		config: Record<string, unknown>,
		message: NotificationMessage,
		context: NotificationContext,
	): Promise<void>;
}
