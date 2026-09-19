import { Right, type Settings } from '@mcs/shared';
import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Granted } from '@/decorators';
import { SettingsManager } from '@/managers';
import { UpdateSettingsDto } from '@/models';

@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
	public constructor(private readonly _settings: SettingsManager) {}

	@Get()
	@Granted(Right.SETTINGS_MANAGE)
	@ApiOperation({
		summary: 'Every setting, defaults filled in',
		description:
			'The table is sparse: a key nobody changed has no row, and comes back on its default.',
	})
	@ApiOkResponse({ description: 'Settings' })
	public read(): Promise<Settings> {
		return this._settings.read();
	}

	@Patch()
	@Granted(Right.SETTINGS_MANAGE)
	@ApiOperation({
		summary: 'Change some settings',
		description:
			'A merge, never a replacement: only the keys that were sent are written, so two screens ' +
			'saving at once cannot overwrite each other’s unrelated fields.',
	})
	@ApiOkResponse({ description: 'Settings' })
	public write(@Body() body: UpdateSettingsDto): Promise<Settings> {
		return this._settings.write(body);
	}
}
