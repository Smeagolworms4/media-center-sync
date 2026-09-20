import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import type { NotificationEvent } from '@mcs/shared';
import { NotificationChannel } from '@/entities';

@Injectable()
export class NotificationChannelRepository extends Repository<NotificationChannel> {
	public constructor(dataSource: DataSource) {
		super(NotificationChannel, dataSource.createEntityManager());
	}

	/** Every channel, oldest first, which is the order they were added in. */
	public findAllOrdered(): Promise<NotificationChannel[]> {
		return this.find({ order: { createdAt: 'ASC' } });
	}

	/**
	 * The channels that should receive one event.
	 *
	 * Filtered in memory rather than in SQL, and deliberately: `events` is JSON in a
	 * `text` column, so the query would be a `LIKE` over a serialised array — which
	 * matches `placement_unconfigured` inside a longer value the day an event name
	 * becomes a prefix of another, and which SQLite and PostgreSQL would need two
	 * different expressions for anyway. A gateway has a handful of channels; the
	 * whole list costs one small read.
	 *
	 * An empty `events` means every event, as the contract says. That is the right
	 * default rather than "none": a channel added and never narrowed is one somebody
	 * wanted to hear from, and it also means an event added in a later version reaches
	 * the channels that already exist instead of being silently unsubscribed.
	 */
	public async findEnabledFor(event: NotificationEvent): Promise<NotificationChannel[]> {
		const channels = await this.find({ where: { enabled: true }, order: { createdAt: 'ASC' } });

		return channels.filter(
			(channel) => channel.events.length === 0 || channel.events.includes(event),
		);
	}

	/**
	 * Record a delivery, and clear whatever was failing before it.
	 *
	 * Clearing matters: a channel still showing March's error while it has been
	 * working since is a channel people stop reading the status of, and then the real
	 * failure is one more line nobody looks at.
	 */
	public async markSent(id: string, at: Date = new Date()): Promise<void> {
		await this.update({ id }, { lastSentAt: at, lastError: null });
	}

	/**
	 * Record a failure in the far end's own words.
	 *
	 * Truncated to the column, because the message is somebody else's: a mail server
	 * that answers with a paragraph would otherwise fail the write itself on
	 * PostgreSQL, turning "the notification failed" into "the row could not be
	 * updated" — and losing the only record that anything went wrong.
	 */
	public async markFailed(id: string, error: string): Promise<void> {
		await this.update({ id }, { lastError: error.slice(0, 1024) });
	}
}
