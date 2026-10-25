// The editor island, in 'create' mode (note_create, on the list page) or
// 'edit' mode (note_edit and note_archive, on the note page). The signal
// holds the last answer for the aria-live line.
import { useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { createRouteClient } from '@cybermole/app-kit/route-table';
import { routes } from '../routes';
import type { Note } from '../lib/notes-core';

/** .value is absent until the elements upgrade. */
interface WaValueHost extends HTMLElement {
  value: string | null;
}

export interface NoteEditorProps {
  mode: 'create' | 'edit';
  /** edit mode only */
  note?: Note | undefined;
}

const client = createRouteClient(routes, { base: import.meta.env.BASE_URL });
const status = signal('— nothing saved yet —');

export default function NoteEditorIsland({ mode, note }: NoteEditorProps) {
  const title = useRef<WaValueHost | null>(null);
  const body = useRef<WaValueHost | null>(null);
  const tags = useRef<WaValueHost | null>(null);

  const read = () => ({
    title: (title.current?.value ?? '').trim(),
    body: (body.current?.value ?? '').trim(),
    tags: (tags.current?.value ?? '')
      .split(',')
      .map(t => t.trim())
      .filter(t => t !== ''),
  });
  const say = (line: string): void => {
    status.value = line;
  };

  const save = async () => {
    const input = read();
    say('…');
    if (mode === 'create') {
      const r = await client.note_create({ params: {}, body: input });
      if (r.ok) {
        say(`saved: ${r.data.note.title} (#${r.data.note.id})`);
        if (title.current) title.current.value = '';
        if (body.current) body.current.value = '';
        if (tags.current) tags.current.value = '';
      } else {
        say(`error: ${r.errorMessage ?? r.errorCode}`);
      }
      return;
    }
    const r = await client.note_edit({ params: { id: note!.id }, body: input });
    say(r.ok ? `saved: ${r.data.note.title}` : `error: ${r.errorMessage ?? r.errorCode}`);
  };

  const archive = async () => {
    say('…');
    const r = await client.note_archive({ params: { id: note!.id } });
    if (r.ok) {
      // Back to the list; the archived note has left the default view.
      window.location.href = `${import.meta.env.BASE_URL}/`;
      return;
    }
    say(`error: ${r.errorMessage ?? r.errorCode}`);
  };

  return (
    <>
      <wa-input label="title" value={note?.title ?? ''} ref={title}></wa-input>
      <wa-textarea label="body" value={note?.body ?? ''} ref={body}></wa-textarea>
      <wa-input label="tags (comma-separated)" value={note?.tags.join(', ') ?? ''} ref={tags}></wa-input>{' '}
      <wa-button variant="brand" onClick={save}>
        {mode === 'create' ? 'save note' : 'save changes'}
      </wa-button>
      {mode === 'edit' && (
        <wa-button variant="danger" onClick={archive}>
          archive
        </wa-button>
      )}
      <p aria-live="polite">{status.value}</p>
    </>
  );
}
