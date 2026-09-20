/**
 * How a gateway tells somebody something happened while they were not looking.
 *
 * A sync runs for hours and finishes at four in the morning; the one thing it must
 * not do is need a browser tab open to be useful. Channels are pluggable for the same
 * reason media services are: the answer to "can it notify me on X" should always be
 * yes, and adding one should touch one file.
 */
export enum NotificationChannelType {
	/**
	 * A push to an ntfy topic, self-hosted or on ntfy.sh.
	 *
	 * The right default for a phone: no account, no app to write, no credential worth
	 * stealing — a topic name and a URL. A household publishes to a topic only they
	 * know, and every phone that subscribes to it gets the notification.
	 */
	NTFY = 'ntfy',
	/**
	 * An ordinary email through an SMTP server.
	 *
	 * Slower and heavier than a push, and worth keeping because it reaches whatever
	 * already notifies somebody. It also survives what push does not: a phone that
	 * changed, an account that moved, a household that reads one shared mailbox.
	 */
	SMTP = 'smtp',
}

/** What is worth interrupting somebody for. */
export enum NotificationEvent {
	/**
	 * A pull landed somewhere nobody chose — the global default, or the fallback
	 * folder, because no category named a destination.
	 *
	 * On by default, and the reason this exists at all. The file is not lost and the
	 * transfer did not fail, so nothing else would ever say a word; the library
	 * simply grows a folder somebody did not plan, and it is found months later.
	 */
	PLACEMENT_UNCONFIGURED = 'placement_unconfigured',
	/** A transfer gave up after its retries. */
	TRANSFER_FAILED = 'transfer_failed',
	/** A run finished, with what it brought. */
	SYNC_FINISHED = 'sync_finished',
	/**
	 * A destination is full, or would be after what is queued.
	 *
	 * Distinct from a failed transfer because it is actionable and not yet a failure:
	 * said in time, somebody frees space and the queue drains. Said as a failure, it
	 * is thirty gigabytes downloaded twice.
	 */
	DISK_FULL = 'disk_full',
	/** A peer asked to link with us and is waiting on an answer. */
	PEER_REQUEST = 'peer_request',
}

export interface NotificationChannel {
	id: string;
	type: NotificationChannelType;
	name: string;
	enabled: boolean;
	/** Which events go out on this channel. Empty means every event. */
	events: NotificationEvent[];
	/**
	 * Channel settings, shaped by the type.
	 *
	 * `ntfy`: `{ url, topic, token? }`. `smtp`: `{ host, port, secure, username?, from, to }`.
	 * Kept opaque here so adding a channel does not widen a type every screen imports;
	 * the handler validates its own, which is the only place that knows what is
	 * required.
	 */
	config: Record<string, unknown>;
	/** Set when the last attempt failed, so a silent channel can be seen to be silent. */
	lastError: string | null;
	lastSentAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export type CreateNotificationChannelRequest = Pick<
	NotificationChannel,
	'type' | 'name' | 'config'
> &
	Partial<Pick<NotificationChannel, 'enabled' | 'events'>>;

export type UpdateNotificationChannelRequest = Partial<CreateNotificationChannelRequest>;

/** One thing that happened, as a channel is asked to deliver it. */
export interface NotificationMessage {
	event: NotificationEvent;
	/** One line. A phone shows this and often nothing else. */
	title: string;
	body: string;
	/** Where to go to act on it, relative to the interface. */
	link: string | null;
}

/**
 * What a test send actually did.
 *
 * Returned rather than thrown for the same reason a service probe is: an SMTP server
 * that refuses the password and one that cannot be reached are both ordinary results
 * a settings screen renders, and turning them into exceptions only moves the mapping
 * somewhere less convenient. A channel that fails silently is a channel nobody can
 * trust, so the far end's own words travel back — they name the port, the
 * certificate or the topic, which no key of ours could.
 */
export interface NotificationTestResult {
	delivered: boolean;
	/** The far end's own words when it refused. Null when it worked. */
	error: string | null;
	sentAt: string | null;
}
