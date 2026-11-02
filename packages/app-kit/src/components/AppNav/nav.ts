export type Section = 'console' | 'apps' | 'builder' | 'jobs' | 'logs' | 'settings';

export type MenuItem = {
  section: Section;
  label: string;
  href: string;
  /** A default-library icon name, or 'cybermole' for the brand glyph. */
  icon: string;
  /** Defaults to nav-<section>. */
  id?: string;
};
