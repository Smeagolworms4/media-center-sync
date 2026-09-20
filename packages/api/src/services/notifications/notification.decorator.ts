import type { NotificationChannelType } from '@mcs/shared';
import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key the notification registry scans for.
 *
 * Exported rather than written twice: a literal repeated in the decorator and in the
 * registry is a typo that produces a handler nobody finds, with nothing to compile
 * against and no error anywhere.
 */
export const NOTIFICATION_CHANNEL_TYPE = 'mcs:notification-channel-type';

/**
 * Marks a provider as the handler for one channel type.
 *
 * The whole extension point, and the same one `@MediaHandler` and `@Transport` are:
 * a third way of notifying somebody is a decorated class and a line in the providers
 * list, with no registry, factory or switch to update.
 */
export const NotificationHandler = (type: NotificationChannelType): ClassDecorator =>
	SetMetadata(NOTIFICATION_CHANNEL_TYPE, type);
