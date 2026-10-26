// In-process domain-event bus. jobs.ts, workspaces.ts and apps.ts emit
// from their service functions; the /ws/events relay forwards to
// subscribed pages, which refresh at once instead of polling. Module-level:
// one per process, like the Scheduler. New topics extend DomainEvent, never
// a second bus.
import { EventEmitter } from 'node:events';
import type { AppSlug, JobName, TerminalId, WorkspaceId } from '@cybermole/app-kit';

/** run_finished fires when a tick observes the end, not at the exit itself. */
export interface JobsEvent {
  topic: 'jobs';
  type:
    'job_created' | 'job_updated' | 'job_deleted' | 'run_started' | 'run_finished' | 'run_killed';
  job: JobName;
  /** for run events */
  firedAt?: number;
}

/** workspaces.ts owns both halves of the sidebar's tree: workspaces and
 *  their terminal tabs. liveness_changed is the watcher's out-of-band heal
 *  (a tmux session dying has no mutation hook); ids name what moved, for
 *  logs — clients re-read state rather than patching from payloads. */
export interface WorkspacesEvent {
  topic: 'workspaces';
  type:
    | 'workspace_created'
    | 'workspace_updated'
    | 'workspace_deleted'
    | 'terminal_created'
    | 'terminal_closed'
    | 'terminal_renamed'
    | 'terminals_reordered'
    | 'liveness_changed';
  workspaceId?: WorkspaceId;
  terminalId?: TerminalId;
}

/** apps.ts: the portfolio groups. Renames never change the slug. */
export interface AppsEvent {
  topic: 'apps';
  type: 'app_created' | 'app_updated' | 'app_deleted';
  slug: AppSlug;
}

export type DomainEvent = JobsEvent | WorkspacesEvent | AppsEvent;

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
