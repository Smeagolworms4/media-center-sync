import { constants } from 'node:fs';
import { access, statfs } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
	ErrorKey,
	MediaServiceScope,
	type Library,
	type LibraryCheck,
	type MediaCategory,
	type UpdateLibraryRequest,
} from '@mcs/shared';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
} from '@nestjs/common';
import type { Library as LibraryEntity } from '@/entities';
import { LibraryRepository, MediaServiceRepository } from '@/repositories';
import { toLibrary } from './mappers';

/** What probing one declared path found. */
export type PathProbe = Omit<LibraryCheck, 'libraryId' | 'name' | 'localPath'>;

/**
 * The libraries of the registered services, and where the gateway can write them.
 *
 * The whole point of this manager is one failure that reports nothing. A library
 * whose `localPath` does not designate the same directory the media service reads
 * accepts every transfer, writes every file, and leaves the service's library empty —
 * with no error anywhere, because nothing did anything wrong. So the path is probed
 * whenever it is set, and a path that cannot be written is refused at the moment
 * somebody types it rather than discovered on the first sync.
 */
@Injectable()
export class LibraryManager {
	private readonly _logger = new Logger(LibraryManager.name);

	public constructor(
		private readonly _libraries: LibraryRepository,
		private readonly _services: MediaServiceRepository,
	) {}

	public async list(serviceId?: string): Promise<Library[]> {
		const libraries =
			serviceId === undefined
				? await this._libraries.find({ order: { name: 'ASC' } })
				: await this._libraries.findByService(serviceId);

		return libraries.map(toLibrary);
	}

	public async read(id: string): Promise<Library> {
		return toLibrary(await this._require(id));
	}

	/**
	 * Set where the gateway writes, and whether this library is a default target.
	 *
	 * Setting a path re-probes it, and a path that is not writable is refused. Storing
	 * it anyway and letting `writable` stay false would look like it worked: the
	 * library would appear configured, and the failure would surface hours later as a
	 * transfer that cannot be placed.
	 */
	public async update(id: string, patch: UpdateLibraryRequest): Promise<Library> {
		const library = await this._require(id);

		if (patch.localPath !== undefined) {
			library.localPath = await this._adoptPath(patch.localPath);
			library.writable = library.localPath !== null;
		}

		if (patch.isDefaultTarget !== undefined) {
			if (patch.isDefaultTarget && !library.writable) {
				// A default target the gateway cannot write to is the same trap one step
				// further on: every sync that falls back to it fails at placement.
				throw new ConflictException(ErrorKey.LIBRARY_PATH_NOT_WRITABLE);
			}

			library.isDefaultTarget = patch.isDefaultTarget;
		}

		if (patch.alias !== undefined) {
			// Trimmed to null rather than stored empty: an alias of one space would merge
			// this library with nothing and show a category with no name.
			library.alias = patch.alias?.trim() || null;
		}

		if (patch.position !== undefined) {
			library.position = patch.position;
		}

		const saved = await this._libraries.save(library);

		// One default per kind, cleared after the save so that a failure above leaves
		// the previous default alone rather than none at all.
		if (saved.isDefaultTarget) {
			await this._libraries.clearDefaultTarget(saved.kind, saved.id);
		}

		return toLibrary(saved);
	}

	/**
	 * Libraries of the same name, seen as one thing.
	 *
	 * A household with two servers has two libraries called `Shows`, and a friend makes
	 * a third. They are one category to the person looking at them, and three bands all
	 * called `Shows` is showing them the plumbing rather than their media. So they merge
	 * on the name somebody would read — the alias when one was set, since that is the
	 * name they chose — compared without case or accents, because `Animes` and `animés`
	 * are not two categories.
	 *
	 * The position is the lowest of the merged ones. That decides the order categories
	 * appear in, and it is also the answer to which category wins when the same media
	 * is filed in two of them: the first one.
	 */
	public async categories(): Promise<MediaCategory[]> {
		const [libraries, services] = await Promise.all([
			this._libraries.find(),
			this._services.find(),
		]);
		const local = new Set(
			services
				.filter((service) => service.scope === MediaServiceScope.LOCAL)
				.map((service) => service.id),
		);
		const merged = new Map<string, MediaCategory>();

		for (const library of libraries) {
			const name = library.alias?.trim() || library.name;
			const key = categoryKeyOf(name);
			const existing = merged.get(key);

			if (existing === undefined) {
				merged.set(key, {
					key,
					name,
					kind: library.kind,
					position: library.position,
					libraryIds: [library.id],
					serviceIds: [library.serviceId],
					itemCount: library.itemCount,
					local: local.has(library.serviceId),
				});

				continue;
			}

			existing.libraryIds.push(library.id);
			existing.itemCount += library.itemCount;
			existing.local = existing.local || local.has(library.serviceId);

			if (!existing.serviceIds.includes(library.serviceId)) {
				existing.serviceIds.push(library.serviceId);
			}

			if (library.position < existing.position) {
				// The lowest position wins the whole category, including the name and the
				// kind it is shown with: whichever library somebody put first is the one
				// they meant this category to be.
				existing.position = library.position;
				existing.name = name;
				existing.kind = library.kind;
			}
		}

		return [...merged.values()].sort(
			(left, right) => left.position - right.position || left.name.localeCompare(right.name),
		);
	}

	/** The libraries behind one merged category, for a query that names it. */
	public async librariesOfCategory(key: string): Promise<string[]> {
		const categories = await this.categories();

		return categories.find((category) => category.key === key)?.libraryIds ?? [];
	}

	/**
	 * What every declared library really looks like from here.
	 *
	 * Read and write are probed separately because they fail for different reasons and
	 * call for different fixes — a readable library the gateway cannot write into is a
	 * permissions problem on this side, and it only ever shows up on the first
	 * transfer otherwise.
	 */
	public async check(): Promise<LibraryCheck[]> {
		const libraries = await this._libraries.find({ order: { name: 'ASC' } });

		return Promise.all(
			libraries.map(async (library) => ({
				libraryId: library.id,
				name: library.name,
				localPath: library.localPath,
				...(await this.probe(library.localPath)),
			})),
		);
	}

	public async probe(localPath: string | null): Promise<PathProbe> {
		if (localPath === null || localPath === '') {
			return {
				exists: false,
				readable: false,
				writable: false,
				freeBytes: null,
				error: ErrorKey.LIBRARY_PATH_UNREADABLE,
			};
		}

		try {
			await access(localPath, constants.F_OK);
		} catch {
			return {
				exists: false,
				readable: false,
				writable: false,
				freeBytes: null,
				error: ErrorKey.LIBRARY_PATH_UNREADABLE,
			};
		}

		const readable = await access(localPath, constants.R_OK).then(
			() => true,
			() => false,
		);
		const writable = await access(localPath, constants.W_OK).then(
			() => true,
			() => false,
		);
		const freeBytes = await statfs(localPath).then(
			(stats) => Number(stats.bavail) * Number(stats.bsize),
			() => null,
		);

		return {
			exists: true,
			readable,
			writable,
			freeBytes,
			error: writable ? null : ErrorKey.LIBRARY_PATH_NOT_WRITABLE,
		};
	}

	/** Null clears the path, which makes the library read-only to us again. */
	private async _adoptPath(localPath: string | null): Promise<string | null> {
		if (localPath === null || localPath.trim() === '') {
			return null;
		}

		const candidate = localPath.trim();

		if (!isAbsolute(candidate)) {
			// A relative path resolves against whatever directory the process happens to
			// have been started in, which is not the same one in a container, in a
			// development shell and in a command.
			throw new BadRequestException(ErrorKey.LIBRARY_PATH_UNREADABLE);
		}

		const probe = await this.probe(candidate);

		if (!probe.writable) {
			this._logger.warn(`Refused ${candidate} as a library path: ${probe.error ?? 'not writable'}`);

			throw new ConflictException(probe.error ?? ErrorKey.LIBRARY_PATH_NOT_WRITABLE);
		}

		return candidate;
	}

	private async _require(id: string): Promise<LibraryEntity> {
		const library = await this._libraries.findOne({ where: { id } });

		if (library === null) {
			throw new NotFoundException(ErrorKey.LIBRARY_NOT_FOUND);
		}

		return library;
	}
}

/**
 * A stable key for a merged category, from the name people read.
 *
 * Case and accents are folded because `Animes` and `animés` are one category, and
 * everything else becomes a hyphen so the key can sit in a URL without being escaped.
 */
const categoryKeyOf = (name: string): string =>
	name
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '') || 'library';
