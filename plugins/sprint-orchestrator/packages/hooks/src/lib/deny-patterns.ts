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
