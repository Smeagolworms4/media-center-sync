import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { Right } from '@mcs/shared';

/** Metadata key the rights guard reads. */
export const GRANTED_RIGHTS = 'mcs:granted-rights';

/**
 * The rights a route requires. All of them, not any of them.
 *
 * Routes are declared in terms of rights and never of roles: `@Granted(Right.SERVICE_MANAGE)`
 * keeps saying the same thing when the role hierarchy is rearranged, while a test on
 * `role === 'admin'` quietly stops matching what it was meant to protect.
 */
export const Granted = (...rights: Right[]): CustomDecorator<string> =>
	SetMetadata(GRANTED_RIGHTS, rights);
