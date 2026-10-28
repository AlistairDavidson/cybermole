// Live client state for the notes pages (signals + the typed route
// client): the editor's status line and the list's notes. The WS doorbell
// (connectNotesSocket) only bumps refreshNotes — data always moves through
// the typed client, the same actions every face serves.
import { signal } from '@preact/signals-core';
import { z } from 'zod';
import { createAppSocket, type AppSocket } from '@cybermole/app-kit/live';
import { createRouteClient } from '@cybermole/app-kit/route-table';
import { routes } from '../routes';
import type { Note } from '../lib/notes-core';

export const client = createRouteClient(routes, { base: import.meta.env.BASE_URL });

export const editorStatus = signal('— nothing saved yet —');

export type SaveNoteInput =
  | { mode: 'create'; title: string; body: string; tags: string[] }
  | { mode: 'edit'; id: number; title: string; body: string; tags: string[] };

/** Sets editorStatus either way (the status strings are the UI contract —
 *  the e2e specs assert them); true = create success, the enhancer's cue
 *  to clear the controls. */
export async function saveNote(input: SaveNoteInput): Promise<boolean> {
  editorStatus.value = '…';
  if (input.mode === 'create') {
    const r = await client.note_create({
      params: {},
      body: { title: input.title, body: input.body, tags: input.tags },
    });
    editorStatus.value = r.ok
      ? `saved: ${r.data.note.title} (#${r.data.note.id})`
      : `error: ${r.errorMessage ?? r.errorCode}`;
    return r.ok;
  }
  const r = await client.note_edit({
    params: { id: input.id },
    body: { title: input.title, body: input.body, tags: input.tags },
  });
  editorStatus.value = r.ok
    ? `saved: ${r.data.note.title}`
    : `error: ${r.errorMessage ?? r.errorCode}`;
  return r.ok;
}

/** True = archived (the enhancer navigates back to the list); a failure
 *  lands in editorStatus. */
export async function archiveNote(id: number): Promise<boolean> {
  editorStatus.value = '…';
  const r = await client.note_archive({ params: { id } });
  if (r.ok) return true;
  editorStatus.value = `error: ${r.errorMessage ?? r.errorCode}`;
  return false;
}

export const notes = signal<Note[] | null>(null);

/** Reads the page's own query (search/tag/archived); empty values stay out
 *  (undefined in URLSearchParams would stringify as 'undefined'). */
export async function refreshNotes(): Promise<void> {
  const sp = new URLSearchParams(location.search);
  const query: { search?: string; tag?: string; archived?: string } = {};
  const search = sp.get('search');
  if (search !== null && search !== '') query.search = search;
  const tag = sp.get('tag');
  if (tag !== null && tag !== '') query.tag = tag;
  const archived = sp.get('archived');
  if (archived !== null && archived !== '') query.archived = archived;
  const r = await client.note_list({ params: {}, query });
  if (r.ok) notes.value = r.data.notes;
}

/** The live list's doorbell: notes_changed → refreshNotes, never data. */
export function connectNotesSocket(): AppSocket {
  return createAppSocket({
    url: () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      return `${proto}://${location.host}${import.meta.env.BASE_URL}/ws`;
    },
    frame: z.object({ type: z.string() }),
    onFrame: frame => {
      if (frame.type === 'notes_changed') void refreshNotes();
    },
  });
}
