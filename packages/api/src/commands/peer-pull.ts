import 'reflect-metadata';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PeerCapability, PeerStatus, type CatalogueEntry } from '@mcs/shared';
import { PeerRepository } from '@/repositories';
import { PeerLinkService, SettingsService } from '@/services';
import { runCommand } from './context';

/**
 * Pulls one file from a linked peer, over the peer link, and says what crossed.
 *
 *     peer:pull [peer name or fingerprint] [published item id]
 *
 * It exists because the peer protocol is the one part of this gateway that cannot be
 * proven from one machine. A unit test can pin the framing and a functional test can
 * prove the endpoint answers; neither can show two gateways, two identities and two
 * media servers agreeing on a version and moving bytes between them. This is what is
 * run against the lab, and what a bug report about the wire should carry the output
 * of.
 *
 * It deliberately goes through `PeerLinkService` rather than through the transfer
 * engine: the engine needs a plan, a source and a target, and none of those exist for
 * a peer whose catalogue has not been imported — which, today, is nothing's job. The
 * gap is real and this command is where it shows.
 */
runCommand(async (app) => {
	const [wanted, itemId] = process.argv.slice(2);
	const peers = app.get(PeerRepository);
	const links = app.get(PeerLinkService);
	const settings = app.get(SettingsService);

	const candidates = await peers.findLinked();
	const peer =
		candidates.find(
			(candidate) =>
				wanted === undefined ||
				candidate.name === wanted ||
				candidate.fingerprint === wanted ||
				candidate.fingerprint.startsWith(wanted),
		) ?? null;

	if (peer === null) {
		process.stdout.write(
			candidates.length === 0
				? 'No linked peer. Link one first — `make lab/link` does it for the lab.\n'
				: `No peer matching "${wanted}". Known: ${candidates.map((one) => one.name).join(', ')}.\n`,
		);
		process.exitCode = 1;

		return;
	}

	const withKey = await peers.findWithPublicKey(peer.id);
	const state = await links.connect(
		{
			id: peer.id,
			name: peer.name,
			fingerprint: peer.fingerprint,
			address: peer.address,
			publicKey: withKey?.publicKey ?? null,
		},
		await settings.getValue('rendezvousUrl'),
	);

	process.stdout.write(
		[
			`peer          ${peer.name} (${peer.fingerprint.slice(0, 16)}…)`,
			`status        ${peer.status === PeerStatus.LINKED ? 'linked' : peer.status}`,
			`link          ${state.mode} at ${state.address ?? '?'}`,
			`protocol      ${state.protocol ?? 'not negotiated'}`,
			`capabilities  ${state.capabilities.join(', ') || 'none advertised'}`,
			'',
		].join('\n'),
	);

	if (!links.supports(peer.id, PeerCapability.CATALOGUE)) {
		// The rule, applied rather than stated: a feature is used because the far end
		// advertised it, never because we have it.
		process.stdout.write('This peer does not advertise a catalogue; nothing to ask it for.\n');

		return;
	}

	const answer = await links.request<{ entries?: CatalogueEntry[] }>(
		peer.id,
		'catalogue.list',
		{},
	);
	const entries = answer.entries ?? [];

	process.stdout.write(`\ncatalogue     ${entries.length} entries they let us see\n`);

	for (const entry of entries.slice(0, 5)) {
		process.stdout.write(
			`  ${entry.externalId}  ${entry.title}${entry.year ? ` (${entry.year})` : ''}` +
				`  ${entry.size === null ? 'size unknown' : `${entry.size} bytes`}\n`,
		);
	}

	const chosen =
		itemId === undefined
			? entries.find((entry) => (entry.size ?? 0) > 0)
			: entries.find((entry) => entry.externalId === itemId);

	if (chosen === undefined) {
		process.stdout.write('\nNothing here has a file to pull.\n');

		return;
	}

	// A range rather than the whole file: it is what a transfer really asks for, so a
	// gateway that only serves whole files would pass a whole-file test and fail every
	// real pull.
	const size = chosen.size ?? 0;
	const end = Math.min(size, 1024 * 1024) - 1;
	const target = join(
		process.env.MCS_TRANSFER_ROOT ?? 'var/transfer',
		'peer-pull',
		`${chosen.externalId}.part`,
	);

	await mkdir(dirname(target), { recursive: true });

	const started = Date.now();
	const stream = await links.openStream(peer.id, 'media.range', {
		serviceId: chosen.externalId,
		externalId: chosen.externalId,
		contentId: chosen.contentId ?? null,
		start: 0,
		end,
	});

	let received = 0;

	stream.on('data', (chunk: Buffer) => {
		received += chunk.length;
	});

	await pipeline(stream, createWriteStream(target));

	process.stdout.write(
		[
			'',
			`pulled        ${chosen.title}`,
			`range         0-${end} of ${size} bytes`,
			`received      ${received} bytes in ${Date.now() - started} ms`,
			`written to    ${target}`,
			'',
		].join('\n'),
	);
});
