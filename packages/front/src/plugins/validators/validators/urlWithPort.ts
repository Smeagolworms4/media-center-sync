import type { Validator } from '../index';
import { Native } from '@/libs/utils';

/**
 * A media service address, the way people actually type it.
 *
 * `new URL()` accepts `http://jellyfin` and `https://plex.tv/anything`, neither of
 * which a gateway on a home network can reach. What is wanted here is a scheme, a
 * host that may well be a bare IP address, an explicit port because these servers
 * never sit on 80 or 443, and no path — the path is the API's business.
 */
export default function urlWithPort (
	this: any,
	{
		message,
		requirePort = true,
	}: {
		message?: string;
		requirePort?: boolean;
	} = {}): Validator {
	return (v: any) => {
		if (Native.empty(v)) {
			return true;
		}
		let parsed: URL;
		try {
			parsed = new URL(String(v));
		} catch {
			return message || this.$t('validators.url_with_port');
		}
		const schemeOk = parsed.protocol === 'http:' || parsed.protocol === 'https:';
		const hostOk = parsed.hostname.length > 0;
		const portOk = !requirePort || parsed.port.length > 0;
		return (schemeOk && hostOk && portOk) || message || this.$t('validators.url_with_port');
	};
}
