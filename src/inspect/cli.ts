#!/usr/bin/env node
import { startInspectServer } from './server.js';
import { resolveProjectRoot } from '../storage/paths.js';

interface CliArgs {
  port: number;
  host: string;
  projectRoot: string;
}

function parseArgs(argv: string[]): CliArgs {
  let port = Number(process.env.KAIRO_INSPECT_PORT ?? 4173);
  let host = process.env.KAIRO_INSPECT_HOST ?? '127.0.0.1';
  let projectRoot = resolveProjectRoot();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') port = Number(argv[++i]);
    else if (a === '--host') host = String(argv[++i]);
    else if (a === '--project' || a === '-C') projectRoot = String(argv[++i]);
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        `kairo-inspect — local read-only inspector for .kairo/ (v0.9.0, ADR-0011)
Usage: kairo-inspect [--port 4173] [--host 127.0.0.1] [--project .]
Loopback only by default. No network egress, no remote assets.\n`,
      );
      process.exit(0);
    }
  }
  return { port, host, projectRoot };
}

async function main(): Promise<void> {
  const { port, host, projectRoot } = parseArgs(process.argv.slice(2));
  const h = await startInspectServer({ port, host, projectRoot });
  process.stdout.write(`Kairo Inspect at ${h.url}  (project: ${projectRoot})\n`);
  process.stdout.write('Read-only · no network · Ctrl+C to stop\n');
  const shutdown = (): void => {
    void h.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`Inspector failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
