import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const PUBLIC_ROUTE = 'mcs:public-route';

/**
 * Says out loud that a route is open.
 *
 * A route with no `@Granted(...)` is already public — the guard has nothing to check
 * — so this changes no behaviour. It exists because "no decorator" and "deliberately
 * no decorator" look identical in a diff, and a reviewer should not have to guess
 * which one a new endpoint is.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(PUBLIC_ROUTE, true);
