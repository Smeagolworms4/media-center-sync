import {
	NotificationChannelType,
	NotificationEvent,
	type NotificationMessage,
} from '@mcs/shared';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { NotificationChannel } from '@/entities';
import type { NotificationChannelRepository } from '@/repositories';
import type { NotificationRegistry, SettingsService } from '@/services';
import { NotificationManager } from './notification.manager';

const row = (overrides: Partial<NotificationChannel> = {}): NotificationChannel =>
	({
		id: 'channel-1',
		type: NotificationChannelType.NTFY,
		name: 'Phones',
		enabled: true,
		events: [],
		config: { url: 'https://ntfy.sh', topic: 'loft', token: 'tk_secret' },
		lastError: null,
		lastSentAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	}) as NotificationChannel;

const message: NotificationMessage = {
	event: NotificationEvent.PLACEMENT_UNCONFIGURED,
	title: 'Twelve files landed where nobody chose',
	body: 'Nothing named a destination.',
	link: '/settings',
};

const build = (world: { channels?: NotificationChannel[] } = {}) => {
	const channels = world.channels ?? [row()];

	const fakes = {
		repository: {
			findAllOrdered: jest.fn().mockResolvedValue(channels),
			findEnabledFor: jest.fn().mockResolvedValue(channels),
			findOne: jest.fn().mockResolvedValue(channels[0] ?? null),
			create: jest.fn((value: Partial<NotificationChannel>) => ({ ...row(), ...value })),
			save: jest.fn((value: NotificationChannel) => Promise.resolve(value)),
			remove: jest.fn().mockResolvedValue(undefined),
			markSent: jest.fn().mockResolvedValue(undefined),
			markFailed: jest.fn().mockResolvedValue(undefined),
		},
		handler: {
			type: NotificationChannelType.NTFY,
			validate: jest.fn(),
			redact: jest.fn((config: Record<string, unknown>) => {
				const { token: _token, ...rest } = config;

				return rest;
			}),
			send: jest.fn().mockResolvedValue(undefined),
		},
	};

	const registry = {
		get: jest.fn(() => fakes.handler),
		find: jest.fn(() => fakes.handler),
	};

	const settings = {
		get: jest.fn().mockResolvedValue({
			publicUrl: 'https://gateway.example',
			instanceName: 'Loft',
		}),
	};

	const manager = new NotificationManager(
		fakes.repository as unknown as NotificationChannelRepository,
		registry as unknown as NotificationRegistry,
		settings as unknown as SettingsService,
	);

	return { manager, fakes, registry, settings };
};

describe('NotificationManager', () => {
	describe('what leaves the API', () => {
		it('never returns a channel’s credentials', async () => {
			// A token that leaks through a list endpoint is one somebody else now has,
			// and nothing in the response would say so.
			const { manager } = build();

			const [channel] = await manager.list();

			expect(channel.config).toEqual({ url: 'https://ntfy.sh', topic: 'loft' });
			expect(JSON.stringify(channel)).not.toContain('tk_secret');
		});

		it('keeps the settings a form has to prefill', async () => {
			// Hiding `config` wholesale would work and would make people retype the
			// whole channel, secret included, every time they renamed it.
			const { manager } = build();

			const channel = await manager.read('channel-1');

			expect(channel.config).toMatchObject({ url: 'https://ntfy.sh', topic: 'loft' });
		});

		it('shows no settings at all for a type this build has no handler for', async () => {
			// What a rollback looks like. Answering 404 for the whole settings screen
			// because one row names an unknown type would be worse than showing it.
			const { manager, registry } = build();

			registry.find.mockReturnValue(null as never);

			const [channel] = await manager.list();

			expect(channel.config).toEqual({});
			expect(channel.name).toBe('Phones');
		});
	});

	describe('adding and changing a channel', () => {
		it('refuses settings the handler cannot use, before the row exists', async () => {
			// A channel saved with no topic looks configured and behaves exactly like
			// one that is not, which is the failure this feature exists to remove.
			const { manager, fakes } = build();

			fakes.handler.validate.mockImplementation(() => {
				throw new BadRequestException({ key: 'error.notification.config_invalid', field: 'topic' });
			});

			await expect(
				manager.create({
					type: NotificationChannelType.NTFY,
					name: 'Phones',
					config: { url: 'https://ntfy.sh' },
				}),
			).rejects.toThrow(BadRequestException);

			expect(fakes.repository.save).not.toHaveBeenCalled();
		});

		it('turns a new channel on, because somebody adding one meant it to work', async () => {
			const { manager, fakes } = build();

			await manager.create({
				type: NotificationChannelType.NTFY,
				name: 'Phones',
				config: { url: 'https://ntfy.sh', topic: 'loft' },
			});

			expect(fakes.repository.create).toHaveBeenCalledWith(
				expect.objectContaining({ enabled: true, events: [] }),
			);
		});

		it('leaves the stored settings alone when an update does not send them', async () => {
			// The interface sends back what it was given, which has had the secrets
			// stripped out of it; overwriting on every save would wipe the token.
			const { manager, fakes } = build();

			await manager.update('channel-1', { name: 'Everybody' });

			expect(fakes.repository.save).toHaveBeenCalledWith(
				expect.objectContaining({
					name: 'Everybody',
					config: { url: 'https://ntfy.sh', topic: 'loft', token: 'tk_secret' },
				}),
			);
		});

		it('keeps a stored credential the new settings do not mention', async () => {
			// The screen fills its form from the response, and the response has had the
			// secrets stripped out of it. A plain replacement would wipe the token every
			// time somebody renamed a channel.
			const { manager, fakes } = build();

			await manager.update('channel-1', { config: { url: 'https://ntfy.example', topic: 'loft' } });

			expect(fakes.repository.save).toHaveBeenCalledWith(
				expect.objectContaining({
					config: { url: 'https://ntfy.example', topic: 'loft', token: 'tk_secret' },
				}),
			);
		});

		it('clears a credential that is sent empty, so removing one can be offered', async () => {
			const { manager, fakes } = build();

			await manager.update('channel-1', {
				config: { url: 'https://ntfy.sh', topic: 'loft', token: '' },
			});

			expect(fakes.repository.save).toHaveBeenCalledWith(
				expect.objectContaining({
					config: { url: 'https://ntfy.sh', topic: 'loft', token: '' },
				}),
			);
		});

		it('answers a key rather than undefined for a channel that is not there', async () => {
			const { manager, fakes } = build();

			fakes.repository.findOne.mockResolvedValue(null);

			await expect(manager.read('missing')).rejects.toThrow(NotFoundException);
		});
	});

	describe('telling somebody something happened', () => {
		it('delivers to a channel that asked for nothing in particular', async () => {
			// An empty event list means every event, as the contract says — which is
			// also what keeps an event added in a later version reaching channels that
			// already exist.
			const { manager, fakes } = build();

			await manager.notify(message);

			expect(fakes.handler.send).toHaveBeenCalledWith(
				expect.objectContaining({ topic: 'loft' }),
				message,
				{ baseUrl: 'https://gateway.example', instanceName: 'Loft' },
			);
			expect(fakes.repository.markSent).toHaveBeenCalledWith('channel-1');
		});

		/**
		 * The promise this whole feature rests on.
		 *
		 * The call sites are in the middle of planning runs and settling jobs. A
		 * notification that breaks a transfer is strictly worse than no notification,
		 * so `notify` resolves whatever a channel does.
		 */
		it('never lets a channel failure reach the thing it was reporting on', async () => {
			const { manager, fakes } = build();

			fakes.handler.send.mockRejectedValue(new Error('invalid access token'));

			await expect(manager.notify(message)).resolves.toBeUndefined();
			expect(fakes.repository.markFailed).toHaveBeenCalledWith(
				'channel-1',
				'invalid access token',
			);
		});

		it('survives a channel type it has no handler for', async () => {
			const { manager, registry } = build();

			registry.get.mockImplementation(() => {
				throw new NotFoundException('error.notification.handler_unknown');
			});

			await expect(manager.notify(message)).resolves.toBeUndefined();
		});

		it('survives the database being unreadable', async () => {
			const { manager, fakes } = build();

			fakes.repository.findEnabledFor.mockRejectedValue(new Error('no such table'));

			await expect(manager.notify(message)).resolves.toBeUndefined();
		});

		it('keeps delivering to the others when one channel fails', async () => {
			// One dead mail server must not silence the push that would have arrived
			// instantly.
			const { manager, fakes } = build({
				channels: [row(), row({ id: 'channel-2', name: 'Mailbox' })],
			});

			fakes.handler.send
				.mockRejectedValueOnce(new Error('connection refused'))
				.mockResolvedValueOnce(undefined);

			await manager.notify(message);

			expect(fakes.handler.send).toHaveBeenCalledTimes(2);
			expect(fakes.repository.markSent).toHaveBeenCalledWith('channel-2');
		});
	});

	describe('the test route', () => {
		it('reports a delivery rather than answering nothing', async () => {
			const { manager, fakes } = build();

			const result = await manager.test('channel-1');

			expect(result).toMatchObject({ delivered: true, error: null });
			expect(result.sentAt).not.toBeNull();
			expect(fakes.repository.markSent).toHaveBeenCalled();
		});

		it('answers with the far end’s own words instead of throwing', async () => {
			// A wrong password and an unreachable host are both ordinary results a
			// settings screen renders, exactly as a media service probe is.
			const { manager, fakes } = build();

			fakes.handler.send.mockRejectedValue(new Error('550 sender not allowed'));

			await expect(manager.test('channel-1')).resolves.toEqual({
				delivered: false,
				error: '550 sender not allowed',
				sentAt: null,
			});
			expect(fakes.repository.markFailed).toHaveBeenCalledWith(
				'channel-1',
				'550 sender not allowed',
			);
		});

		it('reads a Nest refusal as its message rather than as [object Object]', async () => {
			// `String(error)` on one of those renders `[object Object]`, which is how a
			// perfectly clear "topic is required" becomes a channel nobody can fix.
			const { manager, fakes } = build();

			fakes.handler.send.mockRejectedValue({ message: 'topic is required', statusCode: 400 });

			await expect(manager.test('channel-1')).resolves.toMatchObject({
				delivered: false,
				error: 'topic is required',
			});
		});

		it('tests a channel that is switched off, because the switch is not what is being tested', async () => {
			const { manager, fakes } = build({ channels: [row({ enabled: false })] });

			await expect(manager.test('channel-1')).resolves.toMatchObject({ delivered: true });
			expect(fakes.handler.send).toHaveBeenCalled();
		});
	});
});
