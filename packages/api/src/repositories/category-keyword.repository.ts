import { Injectable } from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
import { CategoryKeyword } from '@/entities';

@Injectable()
export class CategoryKeywordRepository extends Repository<CategoryKeyword> {
	public constructor(dataSource: DataSource) {
		super(CategoryKeyword, dataSource.createEntityManager());
	}

	/**
	 * Every keyword, in the order they were written.
	 *
	 * Ordered so that two calls that fold the same libraries fold them the same way:
	 * the merge reads this list, and an unordered one would make the category a
	 * library lands in depend on the order rows happened to come back in.
	 */
	public findAllOrdered(): Promise<CategoryKeyword[]> {
		return this.find({ order: { createdAt: 'ASC', id: 'ASC' } });
	}

	public findByNormalized(normalized: string): Promise<CategoryKeyword | null> {
		return this.findOne({ where: { normalized } });
	}

	public findByLibraries(libraryIds: string[]): Promise<CategoryKeyword[]> {
		return libraryIds.length === 0
			? Promise.resolve([])
			: this.find({ where: { libraryId: In(libraryIds) }, order: { createdAt: 'ASC' } });
	}
}
