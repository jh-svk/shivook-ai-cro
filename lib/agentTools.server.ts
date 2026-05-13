import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import type Anthropic from "@anthropic-ai/sdk";

const execFileAsync = promisify(execFile);

// Explicit allowlist of safe command + args combinations.
// Keyed by command; value is a Set of allowed first-argument strings.
// Any invocation not in this map is rejected regardless of the command name.
const SAFE_INVOCATIONS: Record<string, Set<string>> = {
  npm:  new Set(["run", "install"]),
  npx:  new Set(["tsc", "prisma"]),
  node: new Set(["--version"]),
};

export const BUILDER_TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read a file relative to the working directory",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to cloneDir" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write or overwrite a file; creates parent directories automatically",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to cloneDir" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List files and subdirectories at a path relative to the working directory",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Directory path relative to cloneDir" },
      },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description: "Run an allowlisted shell command (npm, npx, node)",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The executable (npm | npx | node)" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments array",
        },
      },
      required: ["command", "args"],
    },
  },
];

export function getBuilderTools(): Anthropic.Tool[] {
  return BUILDER_TOOLS;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  cloneDir: string
): Promise<string> {
  const cloneDirWithSep = cloneDir.endsWith(path.sep) ? cloneDir : cloneDir + path.sep;

  async function safeResolve(rel: string): Promise<string | null> {
    const joined = path.resolve(cloneDir, rel);
    // Resolve symlinks before the boundary check
    let real: string;
    try {
      real = await fs.realpath(joined);
    } catch {
      // File doesn't exist yet (e.g. write_file creating a new file) — use joined
      real = joined;
    }
    return real.startsWith(cloneDirWithSep) || real === cloneDir ? real : null;
  }

  if (name === "read_file") {
    const resolved = await safeResolve(String(input.path));
    if (!resolved) return "Error: path traversal";
    try {
      return await fs.readFile(resolved, "utf-8");
    } catch (err: unknown) {
      return `Error: ${(err as Error).message}`;
    }
  }

  if (name === "write_file") {
    const resolved = await safeResolve(String(input.path));
    if (!resolved) return "Error: path traversal";
    if (resolved.startsWith(path.resolve(cloneDir, "extensions") + path.sep)) {
      return "Error: extensions/ is off-limits";
    }
    if (resolved === path.resolve(cloneDir, "app/shopify.server.ts")) {
      return "Error: app/shopify.server.ts is off-limits";
    }
    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, String(input.content), "utf-8");
      return "ok";
    } catch (err: unknown) {
      return `Error: ${(err as Error).message}`;
    }
  }

  if (name === "list_directory") {
    const resolved = await safeResolve(String(input.path));
    if (!resolved) return "Error: path traversal";
    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      return entries
        .map((e) => (e.isDirectory() ? `dir: ${e.name}` : `file: ${e.name}`))
        .join("\n");
    } catch (err: unknown) {
      return `Error: ${(err as Error).message}`;
    }
  }

  if (name === "run_command") {
    const command = String(input.command);
    const args = (input.args as string[]) ?? [];
    const firstArg = args[0] ?? "";

    const allowedFirstArgs = SAFE_INVOCATIONS[command];
    if (!allowedFirstArgs) {
      return `Error: command "${command}" is not in the allowlist`;
    }
    if (!allowedFirstArgs.has(firstArg)) {
      return `Error: "${command} ${firstArg}" is not an allowed invocation`;
    }

    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: cloneDir,
        timeout: 300_000,
      });
      return [stdout, stderr].filter(Boolean).join("\n").trim();
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string; message?: string };
      return `Exit ${e.code ?? 1}: ${e.stderr ?? e.message ?? "unknown error"}`;
    }
  }

  return `Error: unknown tool "${name}"`;
}
