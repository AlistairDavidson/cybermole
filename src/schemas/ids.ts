// ids.ts — validating schemas that brand untrusted IDs (request bodies,
// path params, WS frames). The regex and the brand live together: a value
// that passes is the branded type. Node-free — browser code imports these
// too (docs/CODE_STYLE.md §5).
import { z } from 'zod';
import { asJobName, asObjectKey, asPiSessionId, asTmuxSessionName } from '../types/branded';
import { JOB_NAME_RE, OBJECT_KEY_RE, SESSION_ID_RE, TMUX_SESSION_NAME_RE } from './patterns';

export const PiSessionIdSchema = z.string()
  .regex(SESSION_ID_RE, 'invalid session id').transform(asPiSessionId);

export const TmuxSessionNameSchema = z.string()
  .regex(TMUX_SESSION_NAME_RE, 'invalid session name').transform(asTmuxSessionName);

export const JobNameSchema = z.string()
  .regex(JOB_NAME_RE, 'invalid job name').transform(asJobName);

export const ObjectKeySchema = z.string()
  .regex(OBJECT_KEY_RE, 'invalid file key').transform(asObjectKey);
