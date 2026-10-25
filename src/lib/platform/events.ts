// In-process domain-event bus. jobs.ts emits from its service functions;
// the /ws/events relay forwards to subscribed pages, which refresh at once
// instead of waiting for the 15 s poll. Module-level: one per process, like
// the Scheduler. New topics extend DomainEvent, never a second bus.
import { EventEmitter } from 'node:events';
import type { JobName } from '@cybermole/app-kit';

/** run_finished fires when a tick observes the end, not at the exit itself. */
export interface JobsEvent {
  topic: 'jobs';
  type:
    'job_created' | 'job_updated' | 'job_deleted' | 'run_started' | 'run_finished' | 'run_killed';
  job: JobName;
  /** for run events */
  firedAt?: number;
}

export type DomainEvent = JobsEvent;

const bus = new EventEmitter();
bus.setMaxListeners(100); // a listener leak is a bug

export function onDomainEvent(listener: (event: DomainEvent) => void): () => void {
  bus.on('event', listener);
  return () => {
    bus.off('event', listener);
  };
}

/** Only from service functions, never routes, so every actor triggers it. */
export function emitDomainEvent(event: DomainEvent): void {
  bus.emit('event', event);
}
