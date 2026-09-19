import { Injectable } from '@nestjs/common';
import { DataSource, In, Not, Repository } from 'typeorm';
import { LibraryKind } from '@mcs/shared';
import { Library } from '@/entities';

@Injectable()
export class LibraryRepository extends Repository<Library> {
	public constructor(dataSource: DataSource) {
		super(Library, dataSource.createEntityManager());
	}

	public findByService(serviceId: string): Promise<Library[]> {
		return this.find({ where: { serviceId }, order: { name: 'ASC' } });
	}

	public findByServices(serviceIds: string[]): Promise<Library[]> {
		return serviceIds.length === 0
			? Promise.resolve([])
			: this.find({ where: { serviceId: In(serviceIds) }, order: { name: 'ASC' } });
	}

	public findByExternalId(serviceId: string, externalId: string): Promise<Library | null> {
		return this.findOne({ where: { serviceId, externalId } });
	}

	/**
	 * Where media of that kind lands when nothing more specific says otherwise.
	 *
	 * Only a writable library can be a target: one marked as the default but whose
	 * `localPath` the gateway cannot write to accepts transfers that never arrive,
	 * and the failure surfaces on the first file rather than on the setting.
	 */
	public findDefaultTarget(kind: LibraryKind): Promise<Library | null> {
		return this.findOne({ where: { kind, isDefaultTarget: true, writable: true } });
	}

	public findWritable(): Promise<Library[]> {
		return this.find({ where: { writable: true }, order: { name: 'ASC' } });
	}

	/**
	 * Clears the flag on every other library of that kind.
	 *
	 * There is one default per kind. Without this, two libraries can both carry the
	 * flag and which one wins depends on the row order — a placement that changes on
	 * its own between two runs.
	 */
	public async clearDefaultTarget(kind: LibraryKind, except: string): Promise<void> {
		await this.update({ kind, isDefaultTarget: true, id: Not(except) }, { isDefaultTarget: false });
	}

	public async setItemCount(id: string, itemCount: number): Promise<void> {
		await this.update({ id }, { itemCount });
	}

	public async setScanCursor(id: string, scanCursor: string | null, at: Date = new Date()): Promise<void> {
		await this.update({ id }, { scanCursor, lastRefreshAt: at });
	}
}
