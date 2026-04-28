import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import type Anthropic from "@anthropic-ai/sdk";

const execFileAsync = promisify(execFile);

const ALLOWED_COMMANDS = new Set(["git", "npm", "npx", "node"]);

const BLOCKED_ARGS = new Set([
  "--force",
  "reset",
  "clean",
  "&&",
  "||",
  ";",
  "|",
  "$",
  "`",
  "rm",
]);

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
    description: "Run an allowlisted shell command (git, npm, npx, node)",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The executable (git | npm | npx | node)" },
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
  if (name === "read_file") {
    const filePath = String(input.path);
    const resolved = path.resolve(cloneDir, filePath);
    if (!resolved.startsWith(cloneDir)) return "Error: path traversal";
    try {
      return await fs.readFile(resolved, "utf-8");
    } catch (err: unknown) {
      return `Error: ${(err as Error).message}`;
    }
  }

  if (name === "write_file") {
    const filePath = String(input.path);
    const content = String(input.content);
    const resolved = path.resolve(cloneDir, filePath);
    if (!resolved.startsWith(cloneDir)) return "Error: path traversal";
    if (resolved.startsWith(path.resolve(cloneDir, "extensions") + path.sep)) {
      return "Error: extensions/ is off-limits";
    }
    if (resolved === path.resolve(cloneDir, "app/shopify.server.ts")) {
      return "Error: app/shopify.server.ts is off-limits";
    }
    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf-8");
      return "ok";
    } catch (err: unknown) {
      return `Error: ${(err as Error).message}`;
    }
  }

  if (name === "list_directory") {
    const dirPath = String(input.path);
    const resolved = path.resolve(cloneDir, dirPath);
    if (!resolved.startsWith(cloneDir)) return "Error: path traversal";
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

    if (!ALLOWED_COMMANDS.has(command)) {
      return `Error: command "${command}" is not in the allowlist`;
    }
    for (const arg of args) {
      if (BLOCKED_ARGS.has(arg)) {
        return `Error: argument "${arg}" is not allowed`;
      }
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
