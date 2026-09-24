import { Right, type ClassificationProposal } from '@mcs/shared';
import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Granted } from '@/decorators';
import { ClassificationManager } from '@/managers';

/**
 * What the gateway would suggest, asked for out loud.
 *
 * One route, and it is a `GET` — which is the design and not an accident of scope. The
 * household's constraint on this feature was repeated and absolute: a detected category is
 * a suggestion to validate, never automatic. So there is nothing here to post to, nothing
 * that enqueues, and no "apply" verb. Somebody who agrees with a proposal sends
 * `PUT /media/:id/override` with the `libraryId` this answer named — the same single write
 * a person re-filing by hand has always used, so a media that moved moved for a reason
 * that is on the record in one place.
 *
 * A controller of its own rather than a route on `MediaController`, because the two answer
 * different questions and one of them is allowed to be wrong: browsing the index reports
 * what the servers said, and this reports what the gateway suspects. Keeping the suspicion
 * off the item payload is what stops it being read as a fact by a client that never asked.
 */
@ApiTags('classification')
@ApiBearerAuth()
@Controller('classification')
export class ClassificationController {
	public constructor(private readonly _classification: ClassificationManager) {}

	/**
	 * Guarded with `MEDIA_READ` and not `MEDIA_WRITE`, deliberately.
	 *
	 * Reading a suggestion changes nothing, and somebody allowed to browse the library is
	 * allowed to know that something looks misfiled — a guest who spots it can say so. The
	 * act of agreeing is gated where it belongs, on the override route, which already wants
	 * `MEDIA_WRITE`. Gating the read as well would mean the only account that can *see* a
	 * problem is the one that can silently fix it.
	 */
	@Get('media/:id')
	@Granted(Right.MEDIA_READ)
	@ApiOperation({
		summary: 'Categories this media looks like it belongs to, as a proposal',
		description:
			'Read-only, and nothing is filed. Each proposal names the library a subsequent '
			+ 'PUT /media/:id/override would reclassify into, together with the signals that '
			+ 'produced it — a suggestion nobody can check is one people learn to accept without '
			+ 'reading. Categories that were considered and withheld are answered too, so an '
			+ 'empty proposal list can be told apart from a broken route.',
	})
	@ApiOkResponse({ description: 'ClassificationProposal' })
	public propose(@Param('id', ParseUUIDPipe) id: string): Promise<ClassificationProposal> {
		return this._classification.propose(id);
	}
}
