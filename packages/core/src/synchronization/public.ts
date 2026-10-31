// Published language of the synchronization context (FF-BND-001). No other domain context may import
// this file (C5 / FF-BND-002); only the query module and the composition root may.
export type {
  ChangeKind,
  ChangeOrigin,
  ChangeSeq,
  JobKind,
  JobState,
  RevisionStatus,
} from './domain/types.js';
export type {
  ChangeEvent,
  ChangeHint,
  ChangeSource,
  HeadState,
  JobRecord,
  JobRepository,
  Lease,
  LeaseManager,
  PublishConflict,
  RevisionRecord,
  RevisionStore,
  RevisionWriter,
  Unsubscribe,
} from './application/ports.js';
