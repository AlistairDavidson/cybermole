// Seeds the root agent's standing instructions (runtime/workspace-root/AGENTS.md)
// into the default workspace cwd, only where absent: an existing file always
// wins. Whoever owns that dir seeds it (the server in single-user shapes, the
// workspace entrypoint in the split), so files aren't left with the wrong owner.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';

export type SeedRootAgentsData = { target: string; seeded: boolean };
export type SeedRootAgentsErrorCode = 'template_missing' | 'seed_failed';
export type SeedRootAgentsSuccess = ResultSuccess<'seed_root_agents', SeedRootAgentsData>;
export type SeedRootAgentsFailure = ResultFailure<
  'seed_root_agents',
  SeedRootAgentsData,
  SeedRootAgentsErrorCode
>;
export type SeedRootAgentsResult = SeedRootAgentsSuccess | SeedRootAgentsFailure;

/** Never throws. An existing target is success (seeded: false) even without the template. */
export function seedRootAgentsFile(workspaceRoot: string, templateFile: string) {
  const target = path.join(workspaceRoot, 'AGENTS.md');
  try {
    if (fs.existsSync(target)) {
      return {
        ok: true,
        resultType: 'seed_root_agents',
        data: { target, seeded: false },
      } satisfies SeedRootAgentsSuccess;
    }
    if (!fs.existsSync(templateFile)) {
      return {
        ok: false,
        resultType: 'seed_root_agents',
        data: { target, seeded: false },
        errorCode: 'template_missing',
        errorMessage: `the root-agent template is missing (${templateFile}) — nothing seeded`,
      } satisfies SeedRootAgentsFailure;
    }
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.cpSync(templateFile, target);
    return {
      ok: true,
      resultType: 'seed_root_agents',
      data: { target, seeded: true },
    } satisfies SeedRootAgentsSuccess;
  } catch (err) {
    return {
      ok: false,
      resultType: 'seed_root_agents',
      data: { target, seeded: false },
      errorCode: 'seed_failed',
      errorMessage: `could not seed ${target} from ${templateFile}: ${(err as Error).message}`,
    } satisfies SeedRootAgentsFailure;
  }
}
