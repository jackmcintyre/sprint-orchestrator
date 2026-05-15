import * as path from "node:path";

/**
 * Patterns matched against a Bash command string. Each pattern is independently
 * unit-tested in `__tests__/deny-patterns.test.ts` — do not add a regex here
 * without a test.
 */
export const DESTRUCTIVE_BASH_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // rm -rf against root, $HOME, or ~
  { name: "rm-rf-root", re: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(\/|~|\$HOME)(\s|$)/i },
  { name: "rm-rf-root-flag-order", re: /\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+(\/|~|\$HOME)(\s|$)/i },
  // Classic fork bomb
  { name: "fork-bomb", re: /:\s*\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/ },
  // dd writing directly to /dev/...
  { name: "dd-of-dev", re: /\bdd\b[^|]*\bof=\/dev\// },
  // Pipe-curl-to-shell
  { name: "curl-pipe-sh", re: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/ },
  // Write-redirect into system dirs (/etc, /usr, /var, /bin, /sbin, /System)
  {
    name: "redirect-into-system",
    re: /(>{1,2}|tee\s+)\s*(\/etc|\/usr|\/var|\/bin|\/sbin|\/System)\b/,
  },
];

export interface DenyOptions {
  projectRoot: string;
  /**
   * Hosts permitted for WebFetch / WebSearch. Empty means deny all.
   */
  allowedDomains?: string[];
  /**
   * Optional predicate: given an absolute path, return true if the path is
   * gitignored by some enclosing git repository. When supplied, `decideWrite`
   * will allow writes to paths that would otherwise be refused as escaping
   * the project root, provided the path is gitignored. This exemption keeps
   * the gate strict for tracked files (a worktree session still cannot
   * pollute the shared checkout) while letting background-session orchestrator
   * runs write local-only planning artifacts (e.g. files under a gitignored
   * `_bmad-output/`) without a worktree dance.
   *
   * The predicate is injected so the pure path logic stays unit-testable;
   * the production wiring calls `git check-ignore --quiet <path>`.
   */
  isGitignored?: (absolutePath: string) => boolean;
}

export type ToolDecision = { allow: true } | { allow: false; reason: string };

/**
 * Decide whether to allow a Bash command. Returns a denial with a reason
 * when any destructive pattern matches.
 */
export function decideBash(command: string): ToolDecision {
  for (const { name, re } of DESTRUCTIVE_BASH_PATTERNS) {
    if (re.test(command)) return { allow: false, reason: `bash:${name}` };
  }
  return { allow: true };
}

/**
 * Decide whether a Write/Edit-style path stays inside the project root.
 * Symlinks are not resolved — the path is normalised lexically. The whole
 * point is to block traversal attempts, not to fight a sophisticated attacker.
 */
export function decideWrite(targetPath: string, opts: DenyOptions): ToolDecision {
  const projectRoot = path.resolve(opts.projectRoot);
  const resolved = path.resolve(projectRoot, targetPath);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    // Path escapes the project root. Normally refuse — but if a gitignored
    // predicate is supplied AND it confirms the target is gitignored by an
    // enclosing git repo, allow the write. The exemption is intentionally
    // narrow: tracked files outside the project root remain refused, which
    // protects the shared checkout from background-session pollution.
    if (opts.isGitignored && opts.isGitignored(resolved)) {
      return { allow: true };
    }
    return { allow: false, reason: `path-escape:${targetPath}` };
  }
  return { allow: true };
}

/**
 * Decide whether a URL is fetchable. The allowlist matches by host (exact, or
 * `*.example.com` suffix). Empty allowlist denies everything.
 */
export function decideUrl(url: string, opts: DenyOptions): ToolDecision {
  const allowed = opts.allowedDomains ?? [];
  if (allowed.length === 0) return { allow: false, reason: "url:allowlist-empty" };

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return { allow: false, reason: "url:invalid" };
  }
  const match = allowed.some((entry) => {
    if (entry.startsWith("*.")) return host.endsWith(entry.slice(1)) || host === entry.slice(2);
    return host === entry;
  });
  return match ? { allow: true } : { allow: false, reason: `url:not-allowed:${host}` };
}
