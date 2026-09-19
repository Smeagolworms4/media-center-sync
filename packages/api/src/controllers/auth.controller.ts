import type { AuthProvider, SessionUser, SetupState, TokenPair } from '@mcs/shared';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	HttpStatus,
	Post,
	Req,
	UnauthorizedException,
	UseGuards,
} from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiNoContentResponse,
	ApiCreatedResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
	ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ErrorKey } from '@mcs/shared';
import { CurrentUser, Public } from '@/decorators';
import { AuthManager } from '@/managers';
import { ChangePasswordDto, LoginDto, RefreshDto, SetupDto } from '@/models';
import { SessionGuard } from '@/security';

/**
 * A session, and no right in particular.
 *
 * The global rights guard only authenticates a route that asks for a right, so the
 * three routes below — which need to know who is calling and nothing more — carry
 * their own. Passport's guard is subclassed for one reason: its default rejection is
 * the sentence `Unauthorized`, and every failure this API answers is a key the
 * interface can translate. A single route answering prose is enough to make the
 * front-end's error handling special-case it for ever.
 *
 * It lives here rather than under `security/` because it is the plumbing of one
 * controller; the day a second controller needs it, that is where it should move.
 */

/**
 * Getting in, staying in, getting out.
 *
 * The first three routes carry no `@Granted(...)` and that is deliberate rather than
 * forgotten: sign-in cannot require the identity it exists to establish, and neither
 * can the refresh that replaces an access token which has already expired.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
	public constructor(private readonly _auth: AuthManager) {}

	@Get('providers')
	@Public()
	@ApiOperation({
		summary: 'The ways in this gateway offers',
		description:
			'Always includes `internal`, plus `service:<uuid>` for every registered media service ' +
			'flagged as an authentication provider. The interface never guesses these keys: which ' +
			'ways in exist depends on what has been registered.',
	})
	@ApiOkResponse({ description: 'AuthProvider[]' })
	public providers(): Promise<AuthProvider[]> {
		return this._auth.providers();
	}

	@Get('setup')
	@Public()
	@ApiOperation({
		summary: 'Whether this gateway still needs its first administrator',
		description:
			'A fresh install has no account at all. Rather than shipping a default password on ' +
			'something reachable from the network, the gateway says so and the interface asks.',
	})
	@ApiOkResponse({ description: 'SetupState' })
	public setupState(): Promise<SetupState> {
		return this._auth.setupState();
	}

	@Post('setup')
	@Public()
	@HttpCode(HttpStatus.CREATED)
	@ApiOperation({
		summary: 'Create the first administrator',
		description:
			'Open, and refused the moment any account exists — which is the only thing that makes ' +
			'it safe. Answers a session, because telling somebody to go and log in with the ' +
			'credentials they just typed is a step for nobody.',
	})
	@ApiCreatedResponse({ description: 'TokenPair' })
	public setup(@Body() body: SetupDto, @Req() request: Request): Promise<TokenPair> {
		return this._auth.setup(body, {
			userAgent: request.headers['user-agent'] ?? null,
			address: request.ip ?? null,
		});
	}

	@Post('login')
	@Public()
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Sign in through one of the offered providers' })
	@ApiOkResponse({ description: 'TokenPair' })
	@ApiUnauthorizedResponse({ description: 'error.auth.invalid_credentials' })
	public login(@Body() body: LoginDto, @Req() request: Request): Promise<TokenPair> {
		return this._auth.login(body, {
			userAgent: request.headers['user-agent'] ?? null,
			address: request.ip ?? null,
		});
	}

	@Post('refresh')
	@Public()
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Trade a refresh token for a new pair',
		description:
			'Single use. Presenting a token that has already been spent revokes every session of ' +
			'the account: a replayed refresh token is the signature of a leak, not of a retry.',
	})
	@ApiOkResponse({ description: 'TokenPair' })
	public refresh(@Body() body: RefreshDto, @Req() request: Request): Promise<TokenPair> {
		return this._auth.refresh(body.refreshToken, {
			userAgent: request.headers['user-agent'] ?? null,
			address: request.ip ?? null,
		});
	}

	@Post('logout')
	@UseGuards(SessionGuard)
	@HttpCode(HttpStatus.NO_CONTENT)
	@ApiBearerAuth()
	@ApiOperation({ summary: 'Sign out of every session of this account' })
	@ApiNoContentResponse()
	public logout(@CurrentUser() user?: SessionUser): Promise<void> {
		return this._auth.logout(this._identify(user));
	}

	@Get('me')
	@UseGuards(SessionGuard)
	@ApiBearerAuth()
	@ApiOperation({ summary: 'The signed-in account and its rights' })
	@ApiOkResponse({ description: 'SessionUser' })
	public me(@CurrentUser() user?: SessionUser): Promise<SessionUser> {
		return this._auth.session(this._identify(user));
	}

	@Post('password')
	@UseGuards(SessionGuard)
	@HttpCode(HttpStatus.NO_CONTENT)
	@ApiBearerAuth()
	@ApiOperation({
		summary: 'Change the password of this account',
		description:
			'Only for accounts the gateway owns. An account mirrored from a media service has its ' +
			'password where it lives, and storing one here would store a credential nothing checks.',
	})
	@ApiNoContentResponse()
	public password(
		@Body() body: ChangePasswordDto,
		@CurrentUser() user?: SessionUser,
	): Promise<void> {
		return this._auth.changePassword(this._identify(user), body.currentPassword, body.newPassword);
	}

	/**
	 * The signed-in account, or a refusal.
	 *
	 * Borrowing a right to get the guard to run — every role happens to hold
	 * `MEDIA_READ` — would be a lie that breaks silently the day a role stops holding
	 * it, so `SessionGuard` above says what these routes actually need. This check is
	 * the second line: a guard removed by accident would otherwise turn a signed-out
	 * caller into an exception about a property of `undefined`.
	 */
	private _identify(user?: SessionUser): string {
		if (user === undefined) {
			throw new UnauthorizedException(ErrorKey.AUTH_SESSION_EXPIRED);
		}

		return user.id;
	}
}
