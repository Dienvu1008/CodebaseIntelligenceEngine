// Published language of the synchronization context (FF-BND-001). No other domain context may import
// this file (C5 / FF-BND-002); only the query module and the composition root may.
export type {
  ChangeKind,
  ChangeOrigin,
  ChangeSeq,
  Freshness,
  JobKind,
  JobState,
  RevisionStatus,
} from './domain/types.js';
export { changeSeq } from './domain/types.js';
export { isStaging, jobTransition, revisionTransition } from './domain/lifecycle.js';
export type { FreshnessInput, PublishCandidate, PublishContext } from './domain/publish-policy.js';
export { decidePublish, evaluateFreshness } from './domain/publish-policy.js';
export type { RecoveryAction, RecoveryInput, UnfinishedRevision } from './domain/recovery.js';
export { planRecovery } from './domain/recovery.js';
export type { IndexOutcome, IndexServiceDeps, IndexStage, SpanStats } from './application/index-service.js';
export type { CodeDiagnostic, CodeIntelligenceDeps, CodeStats } from './application/code-graph-build.js';
export { runFullIndex } from './application/index-service.js';
export type {
  ChangeEvent,
  ChangeHint,
  ChangeSource,
  HeadState,
  JobRecord,
  JobRepository,
  Lease,
  LeaseManager,
  RevisionRecord,
  RevisionStore,
  RevisionWriter,
  SpanSample,
  StageStats,
  StoredSpan,
  Unsubscribe,
} from './application/ports.js';
export type { SpanCheckOutcome } from './application/span-check.js';
export { DEFAULT_SPAN_SAMPLE, decodeForSpanCheck, verifySpans } from './application/span-check.js';
