import { ErrorKey, type CatalogueEntry } from '@mcs/shared';
import {
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	HttpStatus,
	Param,
	Post,
	Query,
	Req,
	Res,
	StreamableFile,
	UnauthorizedException,
} from '@nestjs/common';
import {
	ApiExcludeController,
	ApiOperation,
	ApiPropertyOptional,
	ApiProperty,
	ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import { PeerRoute, type AuthenticatedRequest } from '@/decorators';
import {
	PeerExchangeManager,
	type AnnouncementAnswer,
	type RevalidationAnswer,
} from '@/managers';
import type { ByteRange } from '@/services';

/** `bytes=0-1023`, the only form a peer sends. An open end means "to the end". */
const RANGE = /^bytes=(\d+)-(\d*)$/;

/**
 * Paging and incremental reads of the catalogue.
 *
 * Local to this controller because these routes are the only thing that speaks it, and
 * because the validation pipe rejects whatever a class does not declare.
 */
class PeerCatalogueQueryDto {
	@ApiPropertyOptional({ description: 'Only what changed since this ISO stamp.' })
	@IsOptional()
	@IsString()
	@MaxLength(64)
	public since?: string;

	@ApiPropertyOptional({ default: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	public page?: number;
}

class PeerRevalidateDto {
	@ApiProperty({ description: 'The identifier we published for that item.' })
	@IsString()
	@IsNotEmpty()
	@MaxLength(64)
	public itemId!: string;
}

/**
 * The routes another gateway calls.
 *
 * Not for browsers, and marked `@PeerRoute()` so that the peer guard demands the link
 * credential rather than the rights guard demanding a session a machine could never
 * have. Nothing here names a `Right`: rights belong to people, and the authority on
 * these routes is the share policy of the library each item sits in.
 *
 * Kept out of the Swagger page: it documents what the interface can call, and these
 * routes are a machine protocol whose contract is `ARCHITECTURE.md`.
 */
@ApiTags('peer')
@ApiExcludeController()
@PeerRoute()
@Controller('peer')
export class PeerExchangeController {
	public constructor(private readonly _exchange: PeerExchangeManager) {}

	@Get('catalogue')
	@ApiOperation({ summary: 'What we share with the calling peer' })
	public catalogue(
		@Query() query: PeerCatalogueQueryDto,
		@Req() request: AuthenticatedRequest,
	): Promise<CatalogueEntry[]> {
		return this._exchange.catalogue(this._caller(request), query);
	}

	@Get('items/:id')
	@ApiOperation({ summary: 'One item’s descriptor' })
	public describe(
		@Param('id') id: string,
		@Req() request: AuthenticatedRequest,
	): Promise<CatalogueEntry> {
		return this._exchange.describe(this._caller(request), id);
	}

	/**
	 * The bytes, ranged.
	 *
	 * A `206` is only claimed when the source really honoured the range: answering
	 * `206` over a stream that started at zero would have the far end write the whole
	 * file at the offset of its first piece, and the corruption would only surface at
	 * verification with nothing pointing at this line.
	 */
	@Get('items/:id/content')
	@ApiOperation({ summary: 'The file, or a range of it' })
	public async content(
		@Param('id') id: string,
		@Headers('range') rangeHeader: string | undefined,
		@Req() request: AuthenticatedRequest,
		@Res({ passthrough: true }) response: Response,
	): Promise<StreamableFile> {
		const range = this._range(rangeHeader);
		const media = await this._exchange.content(this._caller(request), id, range);

		response.setHeader('Content-Type', media.contentType ?? 'application/octet-stream');
		response.setHeader('Accept-Ranges', media.acceptsRanges ? 'bytes' : 'none');

		if (media.contentLength !== null) {
			response.setHeader('Content-Length', media.contentLength);
		}

		if (range !== undefined && media.acceptsRanges) {
			response.status(HttpStatus.PARTIAL_CONTENT);
			response.setHeader(
				'Content-Range',
				`bytes ${range.start}-${range.end}/${media.totalLength ?? '*'}`,
			);
		}

		return new StreamableFile(media.stream);
	}

	@Post('revalidate')
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Re-read one item and report what we actually hold now',
		description:
			'`file: null` means gone, which is an answer. Failing to reach the service is a `503`, ' +
			'because a silence read as "gone" would have the far end abandon a good source.',
	})
	public revalidate(
		@Body() body: PeerRevalidateDto,
		@Req() request: AuthenticatedRequest,
	): Promise<RevalidationAnswer> {
		return this._exchange.revalidate(this._caller(request), body.itemId);
	}

	@Get('announce/:contentId')
	@ApiOperation({ summary: 'Do we hold this content, and do our friends' })
	public announce(
		@Param('contentId') contentId: string,
		@Req() request: AuthenticatedRequest,
	): Promise<AnnouncementAnswer> {
		return this._exchange.announce(this._caller(request), contentId);
	}

	/**
	 * The peer the guard proved, never one the request claims.
	 *
	 * `peerId` is put on the request by the peer guard after it has verified the
	 * signature. Reading it from a header or the body instead would let anybody name a
	 * peer and receive that peer's view of the catalogue.
	 */
	private _caller(request: AuthenticatedRequest): string {
		if (request.peerId === undefined) {
			throw new UnauthorizedException(ErrorKey.PEER_REJECTED);
		}

		return request.peerId;
	}

	private _range(header: string | undefined): ByteRange | undefined {
		const match = header === undefined ? null : RANGE.exec(header.trim());

		if (match === null) {
			return undefined;
		}

		const start = Number(match[1]);
		const end = match[2] === '' ? Number.MAX_SAFE_INTEGER : Number(match[2]);

		return end < start ? undefined : { start, end };
	}
}
