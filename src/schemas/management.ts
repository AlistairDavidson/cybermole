// management.ts — the management page's request bodies and the builder
// marker files (docs/management-page.md), defined once: the /management
// dialogs validate against these in the browser (validation-enhancer-zod)
// and the API routes parse with them on the server; the web side writes
// and the builder reads/writes the marker shapes. Node-free.

import { z } from 'zod';
import { asCommitSha } from '../types/branded';

/** Full git commit sha (40 hex). Branded at the request boundary. */
export const SHA_RE = /^[0-9a-f]{40}$/;

export const CommitShaSchema = z
  .string()
  .regex(SHA_RE, 'a full 40-hex commit sha is required')
  .transform(asCommitSha);

/** GET /api/management/preview's query string (?sha=…). */
export const PreviewQuerySchema = z.object({ sha: CommitShaSchema });

/** The username + password re-confirmation every dangerous verb requires
 *  (docs/management-page.md §1.6) — same fields the login form sends. */
const reauth = {
  username: z.string().trim().min(1, 'username is required').max(200),
  password: z.string().min(1, 'password is required').max(200),
} as const;

/** The checkbox in the confirm dialog: the body is invalid without the
 *  literal true, so a client cannot "forget" it. */
const confirmed = {
  confirm: z.literal(true, { message: 'confirm this action' }),
} as const;

/** POST /api/management/build — request a build of `sha` from the
 *  workspace checkout. */
export const ManagementBuildSchema = z.object({
  sha: CommitShaSchema,
  ...confirmed,
  ...reauth,
});

export type BuildInput = z.output<typeof ManagementBuildSchema>;

/** POST /api/management/activate — swap web to a built release, or roll
 *  back: target is a release sha or 'image' (serve the image copy at the
 *  next boot). */
export const ManagementActivateSchema = z.object({
  target: z.union([z.literal('image'), CommitShaSchema]),
  ...confirmed,
  ...reauth,
});

export type ActivateInput = z.output<typeof ManagementActivateSchema>;

/** The fields the confirm dialog's form carries (shared by both verbs —
 *  the target sha rides in the dialog's state, not the form). */
export const ManagementConfirmFormSchema = z.object({
  ...confirmed,
  ...reauth,
});

// ---- builder marker files (docs/management-page.md §2) ----

/** pending/<sha>.json — web writes, the builder claims (renames to
 *  building/) and answers with done/<sha>.json. */
export const BuildRequestMarkerSchema = z.object({
  sha: z.string().regex(SHA_RE),
  /** the base the enforcement verdict was computed against (audit trail) */
  base: z.string().regex(SHA_RE),
  requestedAt: z.number().int().nonnegative(),
});

export type BuildRequestMarker = z.output<typeof BuildRequestMarkerSchema>;

/** done/<sha>.json — the builder's answer. */
export const BuildDoneMarkerSchema = z.object({
  sha: z.string().regex(SHA_RE),
  status: z.enum(['built', 'failed']),
  builtAt: z.number().int().nonnegative(),
  /** capped builder output tail */
  log: z.string(),
});

export type BuildDoneMarker = z.output<typeof BuildDoneMarkerSchema>;

/** manifest.json inside a release dir — what the release claims to be. */
export const ReleaseManifestSchema = z.object({
  sha: z.string().regex(SHA_RE),
  builtAt: z.number().int().nonnegative(),
  /** free-form builder identification (image tag) */
  builder: z.string(),
});

export type ReleaseManifest = z.output<typeof ReleaseManifestSchema>;
