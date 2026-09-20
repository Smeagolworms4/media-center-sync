import {
	Right,
	type NotificationChannel,
	type NotificationTestResult,
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
	ApiTags,
} from '@nestjs/swagger';
import { Granted } from '@/decorators';
import { NotificationManager } from '@/managers';
import {
	CreateNotificationChannelDto,
	UpdateNotificationChannelDto,
} from '@/models';

/**
 * Managing the ways this gateway can reach somebody.
 *
 * Every route is behind `SETTINGS_MANAGE` rather than a read right of its own. A
 * channel is the gateway's configuration and it carries a credential, and the list
 * alone would tell anybody who could read it which mailbox and which topic this
 * household uses — which is most of what somebody would need to send them a message
 * that looks like it came from here.
 *
 * Nothing here returns a token or a mailbox password: the handler strips its own
 * secrets before the manager builds the response.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications/channels')
export class NotificationController {
	public constructor(private readonly _notifications: NotificationManager) {}

	@Get()
	@Granted(Right.SETTINGS_MANAGE)
	@ApiOperation({ summary: 'Every configured channel, in the order they were added' })
	@ApiOkResponse({ description: 'NotificationChannel[]' })
	public list(): Promise<NotificationChannel[]> {
		return this._notifications.list();
	}

	@Post()
	@Granted(Right.SETTINGS_MANAGE)
	@ApiOperation({
		summary: 'Add a channel',
		description:
			'The handler for the chosen type refuses settings it cannot use, naming the field, ' +
			'so a channel that could never deliver anything is never stored.',
	})
	@ApiOkResponse({ description: 'NotificationChannel' })
	public create(@Body() body: CreateNotificationChannelDto): Promise<NotificationChannel> {
		return this._notifications.create(body);
	}

	@Get(':id')
	@Granted(Right.SETTINGS_MANAGE)
	@ApiOperation({ summary: 'One channel' })
	@ApiOkResponse({ description: 'NotificationChannel' })
	public read(@Param('id', ParseUUIDPipe) id: string): Promise<NotificationChannel> {
		return this._notifications.read(id);
	}

	@Patch(':id')
	@Granted(Right.SETTINGS_MANAGE)
	@ApiOperation({
		summary: 'Change a channel',
		description: 'A field that is not sent is not changed, secrets included.',
	})
	@ApiOkResponse({ description: 'NotificationChannel' })
	public update(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: UpdateNotificationChannelDto,
	): Promise<NotificationChannel> {
		return this._notifications.update(id, body);
	}

	@Delete(':id')
	@Granted(Right.SETTINGS_MANAGE)
	@HttpCode(HttpStatus.NO_CONTENT)
	@ApiOperation({ summary: 'Remove a channel' })
	@ApiNoContentResponse()
	public remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
		return this._notifications.remove(id);
	}

	/**
	 * `200` with a result, never a failure status.
	 *
	 * A channel that refuses the password and one that cannot be reached are both
	 * ordinary answers this screen renders, exactly as a media service probe is — and
	 * a 502 here would be the interface reporting that the *gateway* is broken about
	 * a message the gateway delivered perfectly well to a server that said no.
	 */
	@Post(':id/test')
	@Granted(Right.SETTINGS_MANAGE)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Send one message now and report what happened' })
	@ApiOkResponse({ description: 'NotificationTestResult' })
	public test(@Param('id', ParseUUIDPipe) id: string): Promise<NotificationTestResult> {
		return this._notifications.test(id);
	}
}
