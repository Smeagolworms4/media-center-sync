import type { ServiceConnection } from '@/services';
import type {
	Library as LibraryModel,
	MediaItem as MediaItemModel,
	MediaMatch as MediaMatchModel,
	MediaNode,
	MediaService as MediaServiceModel,
	Pagination,
	Peer as PeerModel,
	ResultList,
	Revalidation as RevalidationModel,
	SharePolicy as SharePolicyModel,
	SyncJob as SyncJobModel,
	SyncPlan as SyncPlanModel,
	Transfer as TransferModel,
	TransferChunk as TransferChunkModel,
	TransferSource,
	User as UserModel,
} from '@mcs/shared';
import type {
	Library,
	MediaItem,
	MediaMatch,
	MediaService,
	Peer,
	Revalidation,
	SharePolicy,
	SyncJob,
	SyncPlan,
	Transfer,
	TransferChunk,
	User,
} from '@/entities';

/**
 * Entities out, exchange shapes in.
 *
 * Managers return the shapes `@mcs/shared` declares rather than the rows behind
 * them, and these functions are the one place the two are reconciled. Returning
 * entities directly would work — the serialisation interceptor even hides the
 * secrets — right up to the day a column is renamed and every screen breaks without
 * a single compilation error, because nothing ever said the wire shape was the table
 * shape.
 *
 * The conversions here are all of the same two kinds: dates become ISO strings, and
 * `bigint` columns become numbers. The second one is not cosmetic — depending on the
 * driver a `bigint` comes back as a string, and `bytesDone > bytesTotal` on two
 * strings compares them alphabetically.
 */

const iso = (value: Date | null | undefined): string | null =>
	value === null || value === undefined ? null : value.toISOString();

/** A `bigint` column, whatever the driver decided to hand back. */
const bytes = (value: number | string | null | undefined): number => Number(value ?? 0);

export const toUser = (user: User): UserModel => ({
	id: user.id,
	username: user.username,
	displayName: user.displayName,
	email: user.email,
	role: user.role,
	provider: user.provider,
	providerUserId: user.providerUserId,
	avatarUrl: user.avatarUrl,
	lastSeenAt: iso(user.lastSeenAt),
	createdAt: user.createdAt.toISOString(),
	updatedAt: user.updatedAt.toISOString(),
});

/**
 * A registered service, without its credentials.
 *
 * The token is never read into this shape, not even to be blanked: a field that
 * exists and happens to be empty is one refactor away from being filled in, and a
 * token that leaks through a list endpoint opens somebody's whole library while every
 * response still looks perfectly normal.
 */
export const toMediaService = (
	service: MediaService,
	counts: { libraryCount: number; itemCount: number } = { libraryCount: 0, itemCount: 0 },
): MediaServiceModel => ({
	id: service.id,
	name: service.name,
	type: service.type,
	scope: service.scope,
	baseUrl: service.baseUrl,
	status: service.status,
	version: service.version,
	authProvider: service.authProvider,
	priority: service.priority,
	peerId: service.peerId,
	lastProbeAt: iso(service.lastProbeAt),
	lastScanAt: iso(service.lastScanAt),
	libraryCount: counts.libraryCount,
	itemCount: counts.itemCount,
	createdAt: service.createdAt.toISOString(),
	updatedAt: service.updatedAt.toISOString(),
});

export const toLibrary = (library: Library): LibraryModel => ({
	id: library.id,
	serviceId: library.serviceId,
	externalId: library.externalId,
	name: library.name,
	kind: library.kind,
	paths: library.paths,
	localPath: library.localPath,
	writable: library.writable,
	isDefaultTarget: library.isDefaultTarget,
	itemCount: library.itemCount,
	lastScanAt: iso(library.lastScanAt),
	lastRefreshAt: iso(library.lastRefreshAt),
	createdAt: library.createdAt.toISOString(),
	updatedAt: library.updatedAt.toISOString(),
});

export const toMediaItem = (item: MediaItem): MediaItemModel => ({
	id: item.id,
	serviceId: item.serviceId,
	libraryId: item.libraryId,
	parentId: item.parentId,
	kind: item.kind,
	title: item.title,
	normalizedTitle: item.normalizedTitle,
	year: item.year,
	seasonNumber: item.seasonNumber,
	episodeNumber: item.episodeNumber,
	externalIds: item.externalIds,
	overview: item.overview,
	artworkUrl: item.artworkUrl,
	file: item.file,
	quality: item.quality,
	addedAt: iso(item.addedAt),
	sync: item.syncState,
	createdAt: item.createdAt.toISOString(),
	updatedAt: item.updatedAt.toISOString(),
});

export const toMediaNode = (item: MediaItem, children?: MediaItem[]): MediaNode => ({
	...toMediaItem(item),
	childCount: item.childCount,
	children: children?.map((child) => ({ ...toMediaItem(child), childCount: child.childCount })),
});

export const toMediaMatch = (match: MediaMatch): MediaMatchModel => ({
	id: match.id,
	localItemId: match.localItemId,
	remoteItemId: match.remoteItemId,
	remoteServiceId: match.remoteServiceId,
	remotePeerId: match.remotePeerId,
	strategy: match.strategy,
	confidence: match.confidence,
	state: match.state,
	reason: match.reason,
	confirmedAt: iso(match.confirmedAt),
	createdAt: match.createdAt.toISOString(),
});

export const toSyncPlan = (plan: SyncPlan): SyncPlanModel => ({
	id: plan.id,
	name: plan.name,
	enabled: plan.enabled,
	trigger: plan.trigger,
	schedule: plan.schedule,
	sourceServiceIds: plan.sourceServiceIds,
	targetLibraryId: plan.targetLibraryId,
	rootItemId: plan.rootItemId,
	filter: plan.filter,
	lastRunAt: iso(plan.lastRunAt),
	nextRunAt: iso(plan.nextRunAt),
	createdAt: plan.createdAt.toISOString(),
	updatedAt: plan.updatedAt.toISOString(),
});

export const toSyncJob = (job: SyncJob, planName: string | null = null): SyncJobModel => ({
	id: job.id,
	planId: job.planId,
	planName,
	state: job.state,
	trigger: job.trigger,
	startedAt: iso(job.startedAt),
	finishedAt: iso(job.finishedAt),
	itemsPlanned: job.itemsPlanned,
	itemsDone: job.itemsDone,
	itemsFailed: job.itemsFailed,
	bytesPlanned: bytes(job.bytesPlanned),
	bytesDone: bytes(job.bytesDone),
	error: job.error,
	createdAt: job.createdAt.toISOString(),
});

/**
 * A transfer as a REST caller sees it.
 *
 * `rate`, `etaSeconds` and the live source list are whatever the caller supplies —
 * normally nothing. They are measured over a window inside the engine and pushed on
 * the event stream many times a second; reading them back from stored bytes would
 * give an average since the transfer started, which is a different number that looks
 * like the same one.
 */
export const toTransfer = (
	transfer: Transfer,
	extra: {
		kind?: string;
		chunksDone?: number;
		rate?: number;
		etaSeconds?: number | null;
		sources?: TransferSource[];
	} = {},
): TransferModel => ({
	id: transfer.id,
	jobId: transfer.jobId,
	itemId: transfer.itemId,
	contentId: transfer.contentId,
	title: transfer.title,
	kind: extra.kind ?? '',
	state: transfer.state,
	targetPath: transfer.targetPath,
	bytesTotal: bytes(transfer.bytesTotal),
	bytesDone: bytes(transfer.bytesDone),
	rate: extra.rate ?? 0,
	etaSeconds: extra.etaSeconds ?? null,
	sources: extra.sources ?? [],
	chunkSize: transfer.chunkSize,
	chunksTotal: transfer.chunksTotal,
	chunksDone: extra.chunksDone ?? 0,
	error: transfer.error,
	errorKind: transfer.errorKind,
	chunksRepaired: transfer.chunksRepaired,
	lastVerifiedAt: iso(transfer.lastVerifiedAt),
	startedAt: iso(transfer.startedAt),
	finishedAt: iso(transfer.finishedAt),
	createdAt: transfer.createdAt.toISOString(),
	updatedAt: transfer.updatedAt.toISOString(),
});

export const toTransferChunk = (chunk: TransferChunk): TransferChunkModel => ({
	index: chunk.index,
	start: bytes(chunk.start),
	end: bytes(chunk.end),
	state: chunk.state,
	bytesDone: bytes(chunk.bytesDone),
	sourceServiceId: chunk.sourceServiceId,
	attempts: chunk.attempts,
	checksum: chunk.checksum,
});

export const toRevalidation = (
	revalidation: Revalidation,
	sourceServiceName = '',
): RevalidationModel => ({
	id: revalidation.id,
	transferId: revalidation.transferId,
	sourceServiceId: revalidation.sourceServiceId,
	sourceServiceName,
	cause: revalidation.cause,
	requestedAt: revalidation.requestedAt.toISOString(),
	answeredAt: iso(revalidation.answeredAt),
	outcome: revalidation.outcome,
	remoteFile: revalidation.remoteFile,
	action: revalidation.action,
	note: revalidation.note,
});

export const toPeer = (
	peer: Peer,
	extra: {
		viaPeerName?: string | null;
		serviceCount?: number;
		sharedItemCount?: number;
	} = {},
): PeerModel => ({
	id: peer.id,
	name: peer.name,
	fingerprint: peer.fingerprint,
	status: peer.status,
	trust: peer.trust,
	linkMode: peer.linkMode,
	address: peer.address,
	viaPeerId: peer.viaPeerId,
	viaPeerName: extra.viaPeerName ?? null,
	serviceCount: extra.serviceCount ?? 0,
	sharedItemCount: extra.sharedItemCount ?? 0,
	lastSeenAt: iso(peer.lastSeenAt),
	createdAt: peer.createdAt.toISOString(),
	updatedAt: peer.updatedAt.toISOString(),
});

export const toSharePolicy = (
	policy: SharePolicy,
	library: { name: string; serviceId: string } | null,
): SharePolicyModel => ({
	id: policy.id,
	libraryId: policy.libraryId,
	libraryName: library?.name ?? '',
	serviceId: library?.serviceId ?? '',
	visibility: policy.visibility,
	allowedPeerIds: policy.allowedPeerIds,
	deniedPeerIds: policy.deniedPeerIds,
	metadataOnly: policy.metadataOnly,
	rateLimit: bytes(policy.rateLimit),
	updatedAt: policy.updatedAt.toISOString(),
});

/** The largest page the API will hand out, whatever a caller asks for. */
export const MAX_PAGE_SIZE = 200;

export const DEFAULT_PAGE_SIZE = 50;

/**
 * Clamp a page request into something the database can serve.
 *
 * A limit taken at its word turns one request into a query nobody can serve and a
 * response nobody can render, and a page below one produces a negative offset that
 * most drivers accept and then answer strangely.
 */
export const pageBounds = (page?: number, limit?: number): { page: number; limit: number } => ({
	page: Math.max(1, Math.floor(page ?? 1)),
	limit: Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit ?? DEFAULT_PAGE_SIZE))),
});

export const paginate = <T>(items: T[], total: number, page: number, limit: number): ResultList<T> => {
	const pagination: Pagination = {
		page,
		limit,
		total,
		pages: limit > 0 ? Math.ceil(total / limit) : 0,
	};

	return { items, pagination };
};

/**
 * What a handler needs to reach a service.
 *
 * The secrets are `select: false` on the entity, so the caller has to have loaded the
 * row through `findWithSecrets`. Passing a row read the ordinary way produces a
 * connection with no token, which fails as an authentication error rather than as the
 * programming mistake it is — worth checking first when a handler suddenly answers 401.
 */
export const toConnection = (service: MediaService): ServiceConnection => ({
	id: service.id,
	type: service.type,
	baseUrl: service.baseUrl,
	token: service.token,
	username: service.username,
	password: service.password,
});
