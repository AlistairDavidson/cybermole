// A small option parser: --flag, --flag=value, --flag value, short aliases
// (-a value) and `--`. No clustering. Usage errors come back as strings.

export interface ParsedArgs {
  positionals: string[];
  /** canonical (long) name → the option's value, or `true` for a flag */
  options: Record<string, string | boolean>;
  /** usage errors in order (unknown option, dangling value) */
  usageErrors: string[];
}

export interface ArgSpec {
  /** options that take no value (--json, --help, …) */
  flags?: string[];
  /** options that take one value (--app <slug>, …) */
  values?: string[];
  /** short → canonical long name (-a → --app) */
  aliases?: Record<string, string>;
}

export function parseArgs(argv: string[], spec: ArgSpec): ParsedArgs {
  const flags = new Set(spec.flags ?? []);
  const values = new Set(spec.values ?? []);
  const aliases = spec.aliases ?? {};
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const usageErrors: string[] = [];
  const takeValue = (name: string, short: string, inline: string | undefined): void => {
    if (inline !== undefined) {
      options[name] = inline;
      return;
    }
    const next = argv[i + 1];
    if (next === undefined) usageErrors.push(`${short} needs a value`);
    else {
      options[name] = next;
      i++;
    }
  };
  let i = 0;
  let onlyPositionals = false;
  for (; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (onlyPositionals || arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyPositionals = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (values.has(name)) takeValue(name, name, eq === -1 ? undefined : arg.slice(eq + 1));
      else if (flags.has(name)) {
        if (eq !== -1) usageErrors.push(`${name} takes no value`);
        else options[name] = true;
      } else usageErrors.push(`unknown option ${name}`);
      continue;
    }
    // short options are aliases only
    const canonical = aliases[arg];
    if (canonical === undefined) {
      usageErrors.push(`unknown option ${arg}`);
      continue;
    }
    if (values.has(canonical)) takeValue(canonical, arg, undefined);
    else if (flags.has(canonical)) options[canonical] = true;
    else usageErrors.push(`unknown option ${arg}`);
  }
  return { positionals, options, usageErrors };
}
