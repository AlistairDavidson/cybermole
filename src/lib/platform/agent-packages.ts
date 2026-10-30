// Seeds the template's default pi packages (settings.json `packages`) into
// the runtime agent dir. The file-level seeding is only-where-absent, which
// cannot land a NEW key inside an existing settings.json — pi's own writes
// and operator edits own that file. So this merges at the KEY level: the
// default list is added only when the runtime settings.json has no
// `packages` key at all. Any list already there wins, including the empty
// one `pi remove` persists — the deliberate opt-out — so it never comes back.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';

export type SeedAgentPackagesData = { target: string; seeded: boolean };
export type SeedAgentPackagesErrorCode =
  'template_missing' | 'template_invalid' | 'settings_invalid' | 'seed_failed';
export type SeedAgentPackagesSuccess = ResultSuccess<'seed_agent_packages', SeedAgentPackagesData>;
export type SeedAgentPackagesFailure = ResultFailure<
  'seed_agent_packages',
  SeedAgentPackagesData,
  SeedAgentPackagesErrorCode
>;
export type SeedAgentPackagesResult = SeedAgentPackagesSuccess | SeedAgentPackagesFailure;

/** Never throws. A runtime settings.json the file walk has not copied yet
 *  (or a template without packages) is success with nothing to do. */
export function seedAgentPackages(agentDir: string, templateSettingsFile: string) {
  const target = path.join(agentDir, 'settings.json');
  const nothingToDo = (): SeedAgentPackagesSuccess => ({
    ok: true,
    resultType: 'seed_agent_packages',
    data: { target, seeded: false },
  });
  try {
    if (!fs.existsSync(templateSettingsFile)) {
      return {
        ok: false,
        resultType: 'seed_agent_packages',
        data: { target, seeded: false },
        errorCode: 'template_missing',
        errorMessage: `the pi-agent-dir template's settings.json is missing (${templateSettingsFile}) — no default packages seeded`,
      } satisfies SeedAgentPackagesFailure;
    }
    let defaults: unknown;
    try {
      defaults = (
        JSON.parse(fs.readFileSync(templateSettingsFile, 'utf8')) as Record<string, unknown>
      ).packages;
    } catch {
      return {
        ok: false,
        resultType: 'seed_agent_packages',
        data: { target, seeded: false },
        errorCode: 'template_invalid',
        errorMessage: `the pi-agent-dir template's settings.json is not valid JSON (${templateSettingsFile})`,
      } satisfies SeedAgentPackagesFailure;
    }
    if (defaults === undefined || (Array.isArray(defaults) && defaults.length === 0))
      return nothingToDo(); // no defaults to seed
    if (!Array.isArray(defaults)) {
      return {
        ok: false,
        resultType: 'seed_agent_packages',
        data: { target, seeded: false },
        errorCode: 'template_invalid',
        errorMessage: `the pi-agent-dir template's packages is not a list (${templateSettingsFile})`,
      } satisfies SeedAgentPackagesFailure;
    }

    // A missing runtime settings.json is the file walk's copy in flight —
    // it lands from the template (packages included), so nothing to merge.
    if (!fs.existsSync(target)) return nothingToDo();
    let settings: unknown;
    try {
      settings = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      return {
        ok: false,
        resultType: 'seed_agent_packages',
        data: { target, seeded: false },
        errorCode: 'settings_invalid',
        errorMessage: `the runtime settings.json is not valid JSON (${target}) — left untouched`,
      } satisfies SeedAgentPackagesFailure;
    }
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      return {
        ok: false,
        resultType: 'seed_agent_packages',
        data: { target, seeded: false },
        errorCode: 'settings_invalid',
        errorMessage: `the runtime settings.json is not a JSON object (${target}) — left untouched`,
      } satisfies SeedAgentPackagesFailure;
    }
    const runtime = settings as Record<string, unknown>; // typeof narrows to `object` only
    // An existing packages key always wins: the operator's list, pi's own
    // `pi install` writes, or the [] `pi remove` persists as the opt-out.
    if ('packages' in runtime) return nothingToDo();
    runtime.packages = defaults;
    fs.writeFileSync(target, `${JSON.stringify(runtime, null, 2)}\n`);
    return {
      ok: true,
      resultType: 'seed_agent_packages',
      data: { target, seeded: true },
    } satisfies SeedAgentPackagesSuccess;
  } catch (err) {
    return {
      ok: false,
      resultType: 'seed_agent_packages',
      data: { target, seeded: false },
      errorCode: 'seed_failed',
      errorMessage: `could not seed the default pi packages into ${target}: ${(err as Error).message}`,
    } satisfies SeedAgentPackagesFailure;
  }
}
