import type { ReleaseSearchResult } from '@mcs/shared';
import { useI18n } from 'vue-i18n';
import { hasTranslation } from '@/plugins/i18n';

type Failure = ReleaseSearchResult['failed'][number];

/**
 * What to say when an indexer did not answer, in its own words rather than all three.
 *
 * Every refusal used to read "check its address and its key". A key the server refused,
 * an address nothing listens on and an answer that merely took too long are three
 * different problems with three different fixes, and only one of them is the settings —
 * so somebody whose indexer was perfectly configured, behind a gateway busy with a scan,
 * was sent to inspect an address that was right all along.
 *
 * The gateway knows which of the three by the time the row arrives. The generic sentence
 * stays as the fallback, for a key this build's catalogue predates: showing somebody a
 * raw `error.indexer.timeout` is worse than showing them a vague sentence.
 */
export function useReleaseFailure () {
	const { t } = useI18n();

	function failureText (failure: Failure): string {
		if (failure.key && hasTranslation(failure.key)) {
			return t('release.failed_because', {
				indexer: failure.indexer,
				reason: t(failure.key),
			});
		}
		return t('release.failed', { indexer: failure.indexer });
	}

	return { failureText };
}
