// The editor enhancer (CODE_STYLE.md §7): wires the SSR'd controls
// (NotesEditor.astro, this directory) to the notes store — save/archive
// through the typed client, editorStatus into the aria-live line; a create
// success clears the controls for the next capture. The directory owns its
// wa-* halves: wa-client first, then the client-side re-imports.
import '@cybermole/app-kit/wa-client';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import { effect } from '@preact/signals-core';
import { defineElement, waValue } from '@cybermole/app-kit/element';
import { archiveNote, editorStatus, saveNote } from '../../store/notes';
import type { WaValueHost } from '../../wa-elements';

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

  const onGo = (): void => {
    void onSave();
  };
  const onBye = (): void => {
    void onArchive();
  };
  save?.addEventListener('click', onGo);
  archive?.addEventListener('click', onBye);
  const dispose = effect(() => {
    if (out !== null) out.textContent = editorStatus.value;
  });
  return () => {
    save?.removeEventListener('click', onGo);
    archive?.removeEventListener('click', onBye);
    dispose();
  };
});
