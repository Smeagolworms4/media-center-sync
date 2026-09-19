export interface Pagination {
	page: number;
	limit: number;
	total: number;
	pages: number;
}

export interface ResultList<T> {
	items: T[];
	pagination: Pagination;
}
