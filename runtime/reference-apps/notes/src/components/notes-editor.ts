// The editor enhancer (CODE_STYLE.md §7): <notes-editor> wraps the SSR'd
// controls and the aria-live line — create mode (data-mode="create") on the
// list page, edit mode (data-mode="edit" + data-note-id) on the note page.
// This wires save/archive to the notes store and mirrors editorStatus into
// the line; a create success clears the controls for the next capture.
// Enhance, never render — the controls are the content, with the note's
// values already in them.
import { effect } from '@preact/signals-core';
import { defineElement, waValue } from '@cybermole/app-kit/element';
import { archiveNote, editorStatus, saveNote } from '../store/notes';
import type { WaValueHost } from '../wa-elements';

defineElement('notes-editor', host => {
  const mode = host.dataset.mode === 'edit' ? 'edit' : 'create';
  const id = Number(host.dataset.noteId ?? '');
  const title = host.querySelector<WaValueHost>('wa-input[label="title"]');
  const body = host.querySelector<WaValueHost>('wa-textarea');
  const tags = host.querySelector<WaValueHost>('wa-input[label="tags (comma-separated)"]');
  const controls = [title, body, tags];
  const save = host.querySelector('wa-button[variant="brand"]');
  const archive = host.querySelector('wa-button[variant="danger"]');
  const out = host.querySelector('p[aria-live]');

  const onSave = async (): Promise<void> => {
    const fields = {
      title: waValue(title).trim(),
      body: waValue(body).trim(),
      tags: waValue(tags)
        .split(',')
        .map(t => t.trim())
        .filter(t => t !== ''),
    };
    const saved = await saveNote(
      mode === 'edit' ? { mode: 'edit', id, ...fields } : { mode: 'create', ...fields },
    );
    if (!saved || mode !== 'create') return;
    for (const control of controls) {
      if (control !== null) control.value = '';
    }
  };
  const onArchive = async (): Promise<void> => {
    if (mode !== 'edit') return;
    // Back to the list; the archived note has left the default view.
    if (await archiveNote(id)) location.href = `${import.meta.env.BASE_URL}/`;
  };

  save?.addEventListener('click', () => {
    void onSave();
  });
  archive?.addEventListener('click', () => {
    void onArchive();
  });
  return effect(() => {
    if (out !== null) out.textContent = editorStatus.value;
  });
});
