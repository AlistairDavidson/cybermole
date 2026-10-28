// The list's enhancer (CODE_STYLE.md §7): the live update's DOM half. The
// WS doorbell bumps the store's notes signal; this stamps the skeleton from
// NotesList.astro once per note — clone, fill the data-fields, toggle the
// optional elements, clone the tag template per tag. Markup knowledge stays
// in the .astro; this knows field names only. The directory owns its wa-*
// halves (the badge leaves the clones carry upgrade client-side).
import '@cybermole/app-kit/wa-client';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import { effect } from '@preact/signals-core';
import { defineElement } from '@cybermole/app-kit/element';
import { connectNotesSocket, notes } from '../../store/notes';
import { noteExcerpt } from '../../lib/notes-core';
import type { Note } from '../../lib/notes-core';

/** Clone the skeleton once, fill it from the note. */
function stampItem(skeleton: HTMLTemplateElement, note: Note, base: string): HTMLLIElement {
  const li = skeleton.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
  const link = li.querySelector<HTMLAnchorElement>('a[data-field="link"]')!;
  link.href = `${base}/notes/${note.id}`;
  link.textContent = note.title;
  if (!note.archived) li.querySelector('[data-optional="archived"]')?.remove();
  const excerpt = li.querySelector('p[data-field="excerpt"]');
  if (note.body === '') excerpt?.remove();
  else if (excerpt !== null) excerpt.textContent = noteExcerpt(note.body);
  const tagTemplate = li.querySelector<HTMLTemplateElement>('template[data-field="tag"]');
  if (tagTemplate !== null) {
    for (const tag of note.tags) {
      const badge = tagTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
      badge.textContent = tag;
      li.insertBefore(badge, tagTemplate);
    }
    // The stamped item must mirror its SSR twin exactly — no scaffolding.
    tagTemplate.remove();
  }
  return li;
}

defineElement('notes-list', host => {
  const ul = host.querySelector('ul.notes');
  const skeleton = host.querySelector<HTMLTemplateElement>('template[data-item]');
  if (ul === null || skeleton === null) return;
  const base = import.meta.env.BASE_URL;
  const socket = connectNotesSocket();
  const dispose = effect(() => {
    const fresh = notes.value;
    // null until the first nudge: the SSR content stands.
    if (fresh === null) return;
    for (const child of [...ul.children]) child.remove();
    ul.append(...fresh.map(note => stampItem(skeleton, note, base)));
  });
  return () => {
    socket.close();
    dispose();
  };
});
