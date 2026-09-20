export * from './notification.config';
export * from './notification.decorator';
export * from './notification.registry';
export * from './notification-handler.interface';
export * from './ntfy.handler';
export * from './smtp.handler';

import { NotificationRegistry } from './notification.registry';
import { NtfyHandler } from './ntfy.handler';
import { SmtpHandler } from './smtp.handler';

/**
 * Every channel handler, plus the registry that finds them.
 *
 * A new channel type is added here and nowhere else — which is only half true, and
 * the half that bites: the module providing these must also import `DiscoveryModule`
 * or the registry finds none of them, silently. See `NotificationRegistry`.
 */
export const NOTIFICATION_HANDLER_PROVIDERS = [NotificationRegistry, NtfyHandler, SmtpHandler];
