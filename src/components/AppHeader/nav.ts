export type Section = 'console' | 'builder' | 'jobs' | 'logs' | 'settings';

export type MenuItem = {
  section: Section;
  label: string;
  href: string;
  /** A default-library icon name, or 'cybermole' for the brand glyph. */
  icon: string;
  className?: string;
};
