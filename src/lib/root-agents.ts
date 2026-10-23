// root-agents.ts — the workspace-root AGENTS.md seeding (jobs-agent-plan
// §9). root-agents/AGENTS.md in the repo is the versioned template for
// the root agent's standing instructions — scheduled work belongs in
// jobs, a fired run is started-not-finished, check exit codes, the CLI +
// MCP surface — seeded into the DEFAULT WORKSPACE CWD (the workspace
// root: /workspace in the compose split, CYBERMOLE_NEW_SESSION_CWD
// elsewhere) only-where-absent, the pi-template policy: an existing file
// (the operator's own, an app tree's, a checkout that IS the cwd — dev's
// /app bind) always wins, and template updates still land where they're
// new. The seeder is whoever owns the dir, like seedAgentDir
// (server/main.ts): the server at boot in single-user shapes, the
// workspace entrypoint (uid 2000) in the split — web-side writes would
// leave node-owned files the workspace uid can't replace.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResultFailure, ResultSuccess } from '../types/result';

export type SeedRootAgentsData = { target: string; seeded: boolean };
export type SeedRootAgentsErrorCode = 'template_missing' | 'seed_failed';
export type SeedRootAgentsSuccess = ResultSuccess<'seed_root_agents', SeedRootAgentsData>;
export type SeedRootAgentsFailure = ResultFailure<
  'seed_root_agents',
  SeedRootAgentsData,
  SeedRootAgentsErrorCode
>;
export type SeedRootAgentsResult = SeedRootAgentsSuccess | SeedRootAgentsFailure;

/** Copy the template to <workspaceRoot>/AGENTS.md unless a file is
 *  already there — the only-where-absent policy in one function, so the
 *  server boot and the unit tests run the same code. The fs boundary:
 *  every failure is caught here and returned, never thrown. An existing
 *  target is success (seeded: false) even without the template — the
 *  policy is satisfied, there is nothing to do. */
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
