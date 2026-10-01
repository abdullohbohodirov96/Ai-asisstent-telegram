import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config/env.js";
import type { AIProvider, AIRequest, AIResponse, ModelTier } from "./provider.js";

/**
 * AI provider that runs the locally installed Claude Code CLI (`claude -p`) with the
 * owner's own Claude subscription. Meant for the "laptop worker" (src/worker-local.ts):
 * Render only stores updates, the laptop analyses the backlog whenever it is switched on.
 *
 * Safety: the prompts contain third-party chat text (prompt-injection surface), so the CLI
 * runs with ALL tools disabled (--tools ""), customisations off (--safe-mode, no MCP,
 * no skills), no session persistence, in an empty temp directory. It can only return text.
 */
export class ClaudeCliProvider implements AIProvider {
  readonly name = "claude-cli";

  modelFor(tier: ModelTier): string {
    const c = config().claudeCli;
    return tier === "DEEP" ? c.modelDeep : c.modelFast;
  }

  async generate(req: AIRequest): Promise<AIResponse> {
    if (req.audio) throw new Error("claude-cli provider cannot transcribe audio");
    const model = this.modelFor(req.tier);
    const dir = await mkdtemp(path.join(tmpdir(), "assistant-claude-"));
    try {
      const systemFile = path.join(dir, "system.txt");
      await writeFile(systemFile, req.system, "utf8");
      const args = [
        "-p",
        "--output-format", "json",
        "--tools", "",
        "--safe-mode",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--system-prompt-file", systemFile,
        "--model", model,
        "--effort", config().claudeCli.effort,
      ];
      if (req.jsonSchema) args.push("--json-schema", JSON.stringify(req.jsonSchema));
      const out = await runCli(config().claudeCli.path, args, req.user, dir, config().claudeCli.timeoutMs);
      return parseCliResult(out, model);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Parses `claude -p --output-format json` output. Exported for tests. */
export function parseCliResult(stdout: string, model: string): AIResponse {
  let j: any;
  try {
    j = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "");
  } catch {
    throw new Error("claude-cli returned non-JSON output");
  }
  if (j.is_error || j.subtype !== "success") throw new Error(`claude-cli error: ${String(j.subtype ?? "unknown")} ${String(j.api_error_status ?? "")}`.trim());
  const text = j.structured_output !== undefined && j.structured_output !== null ? JSON.stringify(j.structured_output) : String(j.result ?? "");
  const u = j.usage ?? {};
  return {
    text,
    // "claude-cli:" prefix → priced at $0 (covered by the owner's subscription), see config/pricing.ts
    model: `claude-cli:${model}`,
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
  };
}

function runCli(bin: string, args: string[], stdin: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude-cli timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`claude-cli could not start (${bin}): ${e.message}. Set CLAUDE_CLI_PATH.`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // stderr may echo prompt fragments; only keep a short, generic tail
      if (code !== 0 && !out.trim()) reject(new Error(`claude-cli exited with code ${code}: ${err.trim().slice(-200)}`));
      else resolve(out);
    });
    // prompt via stdin: no argv length limits, not visible in `ps`
    child.stdin.end(stdin, "utf8");
  });
}
