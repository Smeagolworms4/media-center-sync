import {
	Right,
	type MediaService,
	type Peer,
	type PeerIdentity,
	type PeerInvite,
} from '@mcs/shared';
import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
} from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiNoContentResponse,
	ApiOkResponse,
	ApiOperation,
	ApiServiceUnavailableResponse,
	ApiTags,
	ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Granted } from '@/decorators';
import { PeerManager } from '@/managers';
import { AcceptPeerInviteDto, CreatePeerInviteDto, RenamePeerDto } from '@/models';

/**
 * Other gateways.
 *
 * The three fixed paths — `identity`, `invites`, `accept` — are declared before the
 * parameterised ones, because Express matches in order and `identity` reaching
 * `:id` first would be read as a peer nobody has.
 */
@ApiTags('peers')
@ApiBearerAuth()
@Controller('peers')
export class PeerController {
	public constructor(private readonly _peers: PeerManager) {}

	@Get()
	@Granted(Right.PEER_READ)
	@ApiOperation({ summary: 'Every peer, linked, pending or blocked' })
	@ApiOkResponse({ description: 'Peer[]' })
	public list(): Promise<Peer[]> {
		return this._peers.list();
	}

	@Get('identity')
	@Granted(Right.PEER_READ)
	@ApiOperation({
		summary: 'What you hand to somebody so they can find you',
		description:
			'The fingerprint, the rendezvous, and whether a direct connection is possible at all. ' +
			'A gateway whose port is not forwarded works, but every transfer goes through a relay.',
	})
	@ApiOkResponse({ description: 'PeerIdentity' })
	public identity(): Promise<PeerIdentity> {
		return this._peers.identity();
	}

	@Post('invites')
	@Granted(Right.PEER_MANAGE)
	@ApiOperation({
		summary: 'Mint a one-shot, expiring invitation',
		description: 'Only the hash of its secret is stored; the secret exists in the URL alone.',
	})
	@ApiOkResponse({ description: 'PeerInvite' })
	public createInvite(@Body() body: CreatePeerInviteDto): Promise<PeerInvite> {
		return this._peers.createInvite(body.ttlMinutes);
	}

	@Post('accept')
	@Granted(Right.PEER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Redeem an invitation and link' })
	@ApiOkResponse({ description: 'Peer' })
	@ApiUnauthorizedResponse({
		description: 'error.peer.invite_invalid when used, error.peer.invite_expired when stale',
	})
	public accept(@Body() body: AcceptPeerInviteDto): Promise<Peer> {
		return this._peers.accept(body.invite, body.name);
	}

	@Get(':id')
	@Granted(Right.PEER_READ)
	@ApiOperation({ summary: 'One peer' })
	@ApiOkResponse({ description: 'Peer' })
	public read(@Param('id', ParseUUIDPipe) id: string): Promise<Peer> {
		return this._peers.read(id);
	}

	@Patch(':id')
	@Granted(Right.PEER_MANAGE)
	@ApiOperation({ summary: 'Rename a peer locally' })
	@ApiOkResponse({ description: 'Peer' })
	public rename(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: RenamePeerDto,
	): Promise<Peer> {
		return this._peers.rename(id, body.name);
	}

	@Delete(':id')
	@Granted(Right.PEER_MANAGE)
	@HttpCode(HttpStatus.NO_CONTENT)
	@ApiOperation({ summary: 'Unlink a peer and forget the services it exposed' })
	@ApiNoContentResponse()
	public remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
		return this._peers.remove(id);
	}

	@Post(':id/block')
	@Granted(Right.PEER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Refuse a peer, from the next request',
		description: 'The live link is closed too: blocking that waits for a restart blocks nothing.',
	})
	@ApiOkResponse({ description: 'Peer' })
	public block(@Param('id', ParseUUIDPipe) id: string): Promise<Peer> {
		return this._peers.block(id);
	}

	@Post(':id/unblock')
	@Granted(Right.PEER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Allow a peer again, without reconnecting to it' })
	@ApiOkResponse({ description: 'Peer' })
	public unblock(@Param('id', ParseUUIDPipe) id: string): Promise<Peer> {
		return this._peers.unblock(id);
	}

	@Post(':id/connect')
	@Granted(Right.PEER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Open the link now, direct if it can be, relayed if it cannot' })
	@ApiOkResponse({ description: 'Peer' })
	@ApiServiceUnavailableResponse({ description: 'error.peer.unreachable' })
	public connect(@Param('id', ParseUUIDPipe) id: string): Promise<Peer> {
		return this._peers.connect(id);
	}

	@Get(':id/services')
	@Granted(Right.PEER_READ)
	@ApiOperation({ summary: 'The services this peer exposes to us' })
	@ApiOkResponse({ description: 'MediaService[]' })
	public services(@Param('id', ParseUUIDPipe) id: string): Promise<MediaService[]> {
		return this._peers.services(id);
	}
}
