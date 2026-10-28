// The live list enhancer (CODE_STYLE.md §7): <notes-list> wraps the SSR'd
// <ul class="notes">. It owns the WS doorbell (notes_changed → the store's
// refreshNotes through the typed client) and rebuilds the list surgically
// when the notes signal changes — the initial null leaves the SSR content
// alone. The wa-badge leaves upgrade client-side; the page script imports
// badge for exactly that.
import { effect } from '@preact/signals-core';
import { defineElement } from '@cybermole/app-kit/element';
import { connectNotesSocket, notes } from '../store/notes';
import type { Note } from '../lib/notes-core';

const BASE = import.meta.env.BASE_URL;

/** Mirrors the SSR li: the link, the archived badge, the body excerpt,
 *  one badge per tag. */
function noteItem(note: Note): HTMLLIElement {
  const li = document.createElement('li');
  li.style.margin = '0.5rem 0';
  const link = document.createElement('a');
  link.href = `${BASE}/notes/${note.id}`;
  link.textContent = note.title;
  li.append(link);
  if (note.archived) {
    const badge = document.createElement('wa-badge');
    badge.textContent = 'archived';
    li.append(badge);
  }
  if (note.body !== '') {
    const p = document.createElement('p');
    p.style.margin = '0.1rem 0';
    p.style.opacity = '0.75';
    p.textContent =
      note.body.length > 160 ? `${note.body.slice(0, 160)}…` : note.body;
    li.append(p);
  }
  for (const tag of note.tags) {
    const badge = document.createElement('wa-badge');
    badge.textContent = tag;
    li.append(badge);
  }
  return li;
}

defineElement('notes-list', host => {
  const socket = connectNotesSocket();
  const list = host.querySelector('ul.notes');
  const dispose = effect(() => {
    const fresh = notes.value;
    if (fresh === null || list === null) return;
    while (list.firstChild !== null) list.firstChild.remove();
    list.append(...fresh.map(noteItem));
  });
  return () => {
    dispose();
    socket.close();
  };
});
