export * from './bandwidth.service';
export * from './cache.service';
export * from './chunk-planner';
export * from './companions';
export * from './event-gateway.service';
export * from './file-move.service';
export * from './filesystem.service';
export * from './fingerprint.service';
export * from './handlers';
export * from './landing-state';
export * from './library-path';
export * from './matching.service';
export * from './media-override';
export * from './metadata.service';
export * from './naming.service';
export * from './notifications';
export * from './nfo';
export * from './path-containment';
export * from './path-match.service';
export * from './placed-by';
export * from './peer-catalogue.service';
export * from './peer-gateway.service';
export * from './peer-introduction.service';
export * from './peer-link.service';
export * from './peer-reconnect.service';
/*
 * Only the provider, and the rest as types.
 *
 * `app.module` registers every class a barrel exports, so an `export *` here would
 * hand Nest the frame reader and the carried-socket class as providers — objects it
 * would build once, at startup, for nobody. See `injectables`.
 */
export { PeerRelayService } from './peer-relay.service';
export type {
	CarriedClient,
	CarriedSession,
	RelayChannel,
	RelayEndpoint,
	RelayTransport,
	RelayedSocket,
} from './peer-relay.service';
export * from './placement.service';
export * from './quality.service';
export * from './revalidation.service';
export * from './run-ceiling';
export * from './scheduler.service';
export * from './service-mode';
export * from './settings.service';
export * from './share-visibility';
export * from './space';
export * from './title-normalizer';
export * from './transfer-engine.service';
export * from './transport';
export * from './verification.service';
export * from './version';

import { CacheService } from './cache.service';
import { EventGatewayService } from './event-gateway.service';
import { FileMoveService } from './file-move.service';
import { FilesystemService } from './filesystem.service';
import { FingerprintService } from './fingerprint.service';
import { MEDIA_HANDLER_PROVIDERS } from './handlers';
import { MatchingService } from './matching.service';
import { MetadataService } from './metadata.service';
import { NamingService } from './naming.service';
import { PathMatchService } from './path-match.service';
import { NOTIFICATION_HANDLER_PROVIDERS } from './notifications';
import { PeerCatalogueService } from './peer-catalogue.service';
import { PeerGatewayService } from './peer-gateway.service';
import { PeerIntroductionService } from './peer-introduction.service';
import { PeerLinkService } from './peer-link.service';
import { PeerReconnectService } from './peer-reconnect.service';
import { PeerRelayService } from './peer-relay.service';
import { PlacementService } from './placement.service';
import { QualityService } from './quality.service';
import { RevalidationService } from './revalidation.service';
import { SchedulerService } from './scheduler.service';
import { SettingsService } from './settings.service';
import { TransferEngineService } from './transfer-engine.service';
import { TRANSPORT_PROVIDERS } from './transport';
import { VerificationService } from './verification.service';

/**
 * Everything this layer provides, for the application module to register.
 *
 * Collected here rather than listed in the module so that adding a service is one
 * edit in the folder that owns it. Two things the importing module still has to do
 * itself, and both fail silently if forgotten: import `DiscoveryModule`, or the
 * handler and transport registries find nothing at all, and import `ScheduleModule`,
 * or `SchedulerRegistry` cannot be injected.
 */
export const SERVICE_PROVIDERS = [
	CacheService,
	SettingsService,
	EventGatewayService,
	SchedulerService,
	FingerprintService,
	FilesystemService,
	FileMoveService,
	QualityService,
	MatchingService,
	NamingService,
	PathMatchService,
	PlacementService,
	MetadataService,
	VerificationService,
	RevalidationService,
	PeerLinkService,
	PeerReconnectService,
	PeerRelayService,
	PeerGatewayService,
	PeerCatalogueService,
	PeerIntroductionService,
	TransferEngineService,
	...MEDIA_HANDLER_PROVIDERS,
	...NOTIFICATION_HANDLER_PROVIDERS,
	...TRANSPORT_PROVIDERS,
];
