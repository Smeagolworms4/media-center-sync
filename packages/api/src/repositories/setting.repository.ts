import { Injectable } from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
import { Setting } from '@/entities';

@Injectable()
export class SettingRepository extends Repository<Setting> {
	public constructor(dataSource: DataSource) {
		super(Setting, dataSource.createEntityManager());
	}

	/**
	 * Every stored key, still JSON-encoded.
	 *
	 * Decoding belongs to the layer that knows the shape of each setting; a repository
	 * that parsed them would have to know them all, and would be edited every time one
	 * is added.
	 */
	public async findAllAsMap(): Promise<Map<string, string>> {
		const rows = await this.find();

		return new Map(rows.map((row) => [row.key, row.value]));
	}

	public findByKeys(keys: string[]): Promise<Setting[]> {
		return keys.length === 0 ? Promise.resolve([]) : this.find({ where: { key: In(keys) } });
	}

	public findByKey(key: string): Promise<Setting | null> {
		return this.findOne({ where: { key } });
	}

	/**
	 * Writes one key, inserting it when it is not there yet.
	 *
	 * The table is sparse on purpose: a gateway upgraded to a newer image finds keys
	 * it has never stored and falls back to their defaults, so a setting nobody
	 * changed has no row at all.
	 */
	public async put(key: string, value: string): Promise<void> {
		await this.upsert({ key, value }, ['key']);
	}

	public async putMany(values: Record<string, string>): Promise<void> {
		const rows = Object.entries(values).map(([key, value]) => ({ key, value }));

		if (rows.length > 0) {
			await this.upsert(rows, ['key']);
		}
	}
}
