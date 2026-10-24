// ids.ts — validating schemas that brand untrusted IDs (request bodies,
// path params, WS frames). The regex and the brand live together: a value
// that passes is the branded type. Node-free — browser code imports these
// too (docs/CODE_STYLE.md §5).
// Moved from src/schemas/ids.ts by task/app-kit (docs/apps-plan.md §5)
// — unchanged apart from the move (the relative imports land inside the
// kit).
import { z } from 'zod';
import {
  asAppId,
  asAppSlug,
  asJobName,
  asObjectKey,
  asTerminalId,
  asTmuxSessionName,
  asWorkspaceId,
} from '../types/branded';
import { APP_SLUG_RE, JOB_NAME_RE, OBJECT_KEY_RE, TMUX_SESSION_NAME_RE, UUID_RE } from './patterns';

export const TmuxSessionNameSchema = z
  .string()
  .regex(TMUX_SESSION_NAME_RE, 'invalid session name')
  .transform(asTmuxSessionName);

export const JobNameSchema = z.string().regex(JOB_NAME_RE, 'invalid job name').transform(asJobName);

export const ObjectKeySchema = z
  .string()
  .regex(OBJECT_KEY_RE, 'invalid file key')
  .transform(asObjectKey);

export const AppIdSchema = z.string().regex(UUID_RE, 'invalid app id').transform(asAppId);

export const WorkspaceIdSchema = z
  .string()
  .regex(UUID_RE, 'invalid workspace id')
  .transform(asWorkspaceId);

export const TerminalIdSchema = z
  .string()
  .regex(UUID_RE, 'invalid terminal id')
  .transform(asTerminalId);

export const AppSlugSchema = z.string().regex(APP_SLUG_RE, 'invalid app slug').transform(asAppSlug);
