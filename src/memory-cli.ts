import { AppDatabase } from "./db.js";
import { MemoryService } from "./memory.js";

function valueFor(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function parseInput(args: string[]): unknown {
  const value = valueFor(args, "--json");
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("--json must contain valid JSON.");
  }
}

function command(args: string[]): string {
  const value = args.find((argument) => !argument.startsWith("--") && argument !== valueForSafe(args, "--memory-dir") && argument !== valueForSafe(args, "--database") && argument !== valueForSafe(args, "--job-id") && argument !== valueForSafe(args, "--json"));
  if (!value) throw new Error("Missing memory command.");
  return value;
}

function valueForSafe(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const memoryDir = valueFor(args, "--memory-dir");
  const databasePath = valueFor(args, "--database");
  const jobId = Number(valueFor(args, "--job-id"));
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new Error("--job-id must be a positive integer.");
  const db = new AppDatabase(databasePath);
  try {
    const service = new MemoryService({ memoryDir, databasePath, cliPath: process.argv[1]!, db });
    const result = service.executeTool(command(args), parseInput(args), jobId);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
