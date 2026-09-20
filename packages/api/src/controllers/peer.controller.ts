import {
	Right,
	type BannedPeer,
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
	ApiConflictResponse,
	ApiNoContentResponse,
	ApiCreatedResponse,
	ApiOkResponse,
	ApiOperation,
	ApiServiceUnavailableResponse,
	ApiTags,
	ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Granted } from '@/decorators';
import { PeerManager } from '@/managers';
import {
	AcceptPeerInviteDto,
	AddPeerDto,
	BanFingerprintDto,
	BanPeerDto,
	CreatePeerInviteDto,
	PeerMaxDepthDto,
	RemovePeerDto,
	RenamePeerDto,
} from '@/models';

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

	@Post()
	@Granted(Right.PEER_MANAGE)
	@HttpCode(HttpStatus.CREATED)
	@ApiOperation({
		summary: 'Link to a peer by fingerprint',
		description:
			'The plain form of an invitation: paste their fingerprint, they get a request showing ' +
			'yours, they accept. Nothing secret travels and nothing expires. The peer stays pending ' +
			'until they answer.',
	})
	@ApiCreatedResponse({ description: 'Peer' })
	public add(@Body() body: AddPeerDto): Promise<Peer> {
		return this._peers.add(body);
	}

	@Post(':id/approve')
	@Granted(Right.PEER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Accept a link somebody asked of us',
		description: 'Only an incoming request: approving our own would claim a link the other side has not agreed to.',
	})
	@ApiOkResponse({ description: 'Peer' })
	@ApiConflictResponse({
		description: 'error.peer.rejected on a request we made ourselves',
	})
	public approve(@Param('id', ParseUUIDPipe) id: string): Promise<Peer> {
		return this._peers.approve(id);
	}

	@Post('invites')
	@Granted(Right.PEER_MANAGE)
	@ApiOperation({
		summary: 'Mint a one-shot, expiring invitation',
		description: 'Only the hash of its secret is stored; the secret exists in the URL alone.',
	})
	// A `201`, which is what the route really answers: it mints something. The
	// annotation said `200`, so the documented status and the served one disagreed.
	@ApiCreatedResponse({ description: 'PeerInvite' })
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

	@Get('bans')
	@Granted(Right.PEER_READ)
	@ApiOperation({
		summary: 'Fingerprints this gateway refuses',
		description:
			'Outlives the peer row: a removed peer can ask again, a banned key cannot — ' +
			'not by request, not by invitation, and not through an introduction.',
	})
	@ApiOkResponse({ description: 'BannedPeer[]' })
	public bans(): Promise<BannedPeer[]> {
		return this._peers.bans();
	}

	@Post('bans')
	@Granted(Right.PEER_MANAGE)
	@HttpCode(HttpStatus.CREATED)
	@ApiOperation({ summary: 'Refuse a fingerprint that was never linked here' })
	@ApiCreatedResponse({ description: 'BannedPeer' })
	public banFingerprint(@Body() body: BanFingerprintDto): Promise<BannedPeer> {
		return this._peers.banFingerprint(body.fingerprint, {
			name: body.name,
			reason: body.reason,
		});
	}

	@Delete('bans/:fingerprint')
	@Granted(Right.PEER_MANAGE)
	@HttpCode(HttpStatus.NO_CONTENT)
	@ApiOperation({
		summary: 'Lift a ban',
		description: 'It re-links nobody. The key is merely allowed to ask again.',
	})
	@ApiNoContentResponse()
	public unban(@Param('fingerprint') fingerprint: string): Promise<void> {
		return this._peers.unban(fingerprint);
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
	public remove(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: RemovePeerDto,
	): Promise<void> {
		return this._peers.remove(id, { ban: body.ban, reason: body.reason });
	}

	@Post(':id/ban')
	@Granted(Right.PEER_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Refuse a peer for good, and unlink them',
		description:
			'Unlike a block, which is a status on a row that stays: a ban survives the row, ' +
			'so the same key cannot return through a request, an invitation or a friend.',
	})
	@ApiOkResponse({ description: 'BannedPeer' })
	public ban(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: BanPeerDto,
	): Promise<BannedPeer> {
		return this._peers.ban(id, body.reason);
	}

	@Patch(':id/max-depth')
	@Granted(Right.PEER_MANAGE)
	@ApiOperation({
		summary: 'How far introductions through this peer may travel',
		description:
			'Null follows the gateway ceiling. Per peer because two friends run different ' +
			'sized circles, and widening one should not widen the other.',
	})
	@ApiOkResponse({ description: 'Peer' })
	public setMaxDepth(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: PeerMaxDepthDto,
	): Promise<Peer> {
		return this._peers.setMaxDepth(id, body.maxDepth);
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
