#!/usr/bin/env node
// Seed the template's default pi packages into the runtime agent dir's
// settings.json — the workspace-entrypoint half of the boot seeding the web
// server runs in single-user shapes (server/main.ts), over the same lib so
// the policy is one implementation: run HERE in the compose split so the
// write is owned by the workspace uid. Prints one line when it seeds;
// failures exit 1 with the message (the entrypoint warns and continues).
import { seedAgentPackages } from '../src/lib/platform/agent-packages';

const [agentDir, templateSettingsFile] = process.argv.slice(2);
if (!agentDir || !templateSettingsFile) {
  console.error('usage: node seed-agent-packages.js <agent-dir> <template-settings.json>');
  process.exit(1);
}
const result = seedAgentPackages(agentDir, templateSettingsFile);
if (!result.ok) {
  console.error(result.errorMessage);
  process.exit(1);
}
if (result.data.seeded)
  console.log('cybermole workspace: seeded the default pi packages into', result.data.target);
