import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { type Check } from "../state/schema.js";

export type CheckResult =
  | {
      type: "shell";
      cmd: string;
      passed: boolean;
      exit_code: number;
      expected_exit: number;
      output: string;
      stdout: string;
      stderr: string;
    }
  | { type: "file_exists"; path: string; passed: boolean }
  | { type: "regex"; cmd: string; pattern: string; passed: boolean; output: string };

export type ValidationResult = { passed: boolean; results: CheckResult[] };

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface RunCheckOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run a single check. Pure with respect to the project state — no mutations
 * to the sprint status file or anywhere else.
 */
export async function runCheck(check: Check, opts: RunCheckOptions = {}): Promise<CheckResult> {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = opts.env ?? process.env;

  switch (check.type) {
    case "file_exists": {
      const resolved = path.isAbsolute(check.path) ? check.path : path.join(cwd, check.path);
      try {
        await fs.access(resolved);
        return { type: "file_exists", path: check.path, passed: true };
      } catch {
        return { type: "file_exists", path: check.path, passed: false };
      }
    }
    case "shell": {
      const { exitCode, output, stdout, stderr } = await runShell(check.cmd, {
        cwd,
        timeoutMs,
        env,
      });
      return {
        type: "shell",
        cmd: check.cmd,
        passed: exitCode === check.expect_exit,
        exit_code: exitCode,
        expected_exit: check.expect_exit,
        output,
        stdout,
        stderr,
      };
    }
    case "regex": {
      const { exitCode, output } = await runShell(check.cmd, { cwd, timeoutMs, env });
      const re = new RegExp(check.pattern);
      // Require the command to succeed before honoring the match — otherwise
      // error output (e.g. "cat: hello.txt: No such file") can spuriously match
      // patterns drawn from the filename or path the user is trying to read.
      return {
        type: "regex",
        cmd: check.cmd,
        pattern: check.pattern,
        passed: exitCode === 0 && re.test(output),
        output,
      };
    }
  }
}

export async function runChecks(
  checks: Check[],
  opts: RunCheckOptions = {},
): Promise<ValidationResult> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await runCheck(check, opts));
  }
  return { passed: results.every((r) => r.passed), results };
}

/** Return the last N lines of a string. */
function lastLines(s: string, n: number): string {
  const lines = s.split("\n");
  return lines.slice(-n).join("\n");
}

async function runShell(
  cmd: string,
  opts: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<{ exitCode: number; output: string; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { cwd: opts.cwd, env: opts.env });
    let stdoutBuf = "";
    let stderrBuf = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdoutBuf += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderrBuf += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = lastLines(stdoutBuf, 20);
      const stderr = lastLines(stderrBuf, 20);
      resolve({
        exitCode: killed ? 124 : (code ?? 1),
        output: stdoutBuf + stderrBuf,
        stdout,
        stderr,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      const stdout = lastLines(stdoutBuf, 20);
      const stderr = lastLines(stderrBuf + (err as Error).message, 20);
      resolve({
        exitCode: 1,
        output: `${stdoutBuf}${stderrBuf}${(err as Error).message}`,
        stdout,
        stderr,
      });
    });
  });
}
