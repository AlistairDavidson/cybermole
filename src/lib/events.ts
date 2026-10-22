// events.ts — the in-process domain-event bus (plan §7, "live
// consistency"). The service layer (src/lib/jobs.ts) emits at its
// mutation/observation choke points; the /ws/events relay (src/lib/
// events-ws.ts) forwards every event to subscribed pages, which run the
// same partial refresh the 15 s poll already runs. That is the "human and
// agent UX always show the same result" guarantee: agent-side changes
// (the internal socket API, plan §3–§4) become visible the moment they
// happen, not up to 15 s later.
//
// WHY A MODULE-LEVEL BUS: the Scheduler is a per-process singleton and
// every mutation path — the browser's /api/jobs routes, the internal
// socket routes (plan §4), the scheduler tick, run-now, kill — funnels
// through its service functions (that placement is the whole guarantee;
// see the emission points in jobs.ts). A module-level bus is the same
// lifetime: one per process, reachable from both the emitter (jobs.ts)
// and the consumer (main.ts's relay) without threading a reference
// through every constructor.
//
// `topic` reserves the bus for later consumers (e.g. retiring the
// workspace sidebar's 15 s poll — deliberately NOT this task): new
// topics extend DomainEvent's union, never a second bus.
import { EventEmitter } from 'node:events';
import type { JobName } from '../types/branded';

/** What happened on the jobs domain. run_finished fires when the
 *  scheduler tick OBSERVES a run's end (the session gone + the exit file
 *  read back) — tick granularity after the process exits, not at the
 *  exit itself; see observeFinish in jobs.ts. */
export interface JobsEvent {
  topic: 'jobs';
  type:
    'job_created' | 'job_updated' | 'job_deleted' | 'run_started' | 'run_finished' | 'run_killed';
  /** the job the event is about */
  job: JobName;
  /** the run's fired_at identity, for the run-shaped events */
  firedAt?: number;
}

/** Everything the bus carries (one topic today — see above). */
export type DomainEvent = JobsEvent;

const bus = new EventEmitter();
bus.setMaxListeners(100); // the relay + tests; a listener leak is a bug, not a mode

/** Subscribe to every domain event. Returns the unsubscribe function. */
export function onDomainEvent(listener: (event: DomainEvent) => void): () => void {
  bus.on('event', listener);
  return () => {
    bus.off('event', listener);
  };
}

/** Emit a domain event. Called ONLY from the service layer's choke
 *  points (src/lib/jobs.ts) — never from an HTTP route, which would
 *  break the "whoever acted, the event fires" guarantee. Synchronous,
 *  like every EventEmitter listener list in this codebase. */
export function emitDomainEvent(event: DomainEvent): void {
  bus.emit('event', event);
}
