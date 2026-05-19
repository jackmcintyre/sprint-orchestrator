#!/usr/bin/env python3
"""ship-story plumbing.

Deterministic helpers so the SKILL.md orchestrator only handles judgment work.
Every subcommand exits non-zero on failure with a human-readable message on stderr
and emits structured JSON on stdout when it has a result the orchestrator needs to parse.

Subcommands:
  preflight                       sanity-check the environment before a run
  resolve [story_id]              pick story, extract ACs, return JSON
  worktree <story_key>            create worktree + branch off origin/main
  set-status <key> <status>       atomic mutation of sprint-status.yaml
  verify-ac-table <results.json>  hard gate: fail if any AC row not green
  pr-body <story_key> <results.json> <review_passes>   emit markdown PR body
  record <story_key> <event>      append JSONL event to run log (resumability)
  state <story_key> [--get STEP]  read run state for resume
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.stderr.write(
        "ERROR: PyYAML required. Install: python3 -m pip install --user pyyaml\n"
    )
    sys.exit(2)

# scripts/ship.py → ship-story/scripts/ship.py → ship-story/ → skills/ → .claude/ → repo
REPO = Path(__file__).resolve().parents[4]
STATUS_FILE = REPO / "_bmad-output/implementation-artifacts/sprint-status.yaml"
EPICS_DIR = REPO / "_bmad-output/planning-artifacts/epics"
RUNS_DIR = REPO / ".claude/skills/ship-story/.runs"


# ---------------------------------------------------------------- helpers


def die(msg: str, code: int = 1) -> None:
    sys.stderr.write(f"ERROR: {msg}\n")
    sys.exit(code)


def load_status() -> dict:
    if not STATUS_FILE.exists():
        die(f"sprint-status.yaml not found at {STATUS_FILE}")
    return yaml.safe_load(STATUS_FILE.read_text())


def save_status(data: dict) -> None:
    """Atomic write — tmp file then rename."""
    data["last_updated"] = dt.date.today().isoformat()
    tmp = STATUS_FILE.with_suffix(".yaml.tmp")
    tmp.write_text(yaml.safe_dump(data, sort_keys=False))
    tmp.replace(STATUS_FILE)


def story_keys(dev_status: dict) -> list[str]:
    return [
        k for k in dev_status
        if not k.startswith("epic-") and "retrospective" not in k
    ]


def run_log(story_key: str) -> Path:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    return RUNS_DIR / f"{story_key}.jsonl"


# ---------------------------------------------------------------- preflight


def cmd_preflight(_args) -> None:
    issues: list[str] = []

    if not STATUS_FILE.exists():
        issues.append(f"sprint-status.yaml missing: {STATUS_FILE}")
    if not EPICS_DIR.exists():
        issues.append(f"epics dir missing: {EPICS_DIR}")

    rc = subprocess.run(
        ["git", "status", "--porcelain"], cwd=REPO, capture_output=True, text=True
    )
    if rc.returncode != 0:
        issues.append("git status failed — is this a repo?")
    elif rc.stdout.strip():
        issues.append("working tree is dirty — commit or stash before shipping")

    rc = subprocess.run(["gh", "auth", "status"], capture_output=True)
    if rc.returncode != 0:
        issues.append("gh CLI not authenticated — run `gh auth login`")

    if issues:
        for i in issues:
            sys.stderr.write(f"- {i}\n")
        die(f"{len(issues)} preflight issue(s)")
    print(json.dumps({"preflight": "ok"}))


# ---------------------------------------------------------------- resolve


_AC_HEADING_RE = re.compile(
    r"\*{0,2}Acceptance Criteria[\s:\*]*\n+", re.IGNORECASE
)


def extract_acs(story_body: str) -> list[str]:
    """Pull AC blocks out of a story section.

    Stories in this repo use Given/When/Then paragraph blocks separated by blank
    lines, sometimes with explicit `**ACN:**` labels. We split on blank lines and
    flatten each block to a single line for table-friendly rendering.
    """
    m = _AC_HEADING_RE.search(story_body)
    if not m:
        return []
    tail = story_body[m.end():]
    blocks = re.split(r"\n\s*\n", tail.strip())
    acs: list[str] = []
    for block in blocks:
        flat = " ".join(line.strip() for line in block.splitlines() if line.strip())
        if not flat:
            continue
        # Stop at any heading line that slipped through (defence-in-depth)
        if flat.startswith("#"):
            break
        acs.append(flat)
    return acs


def pick_story(dev_status: dict, story_id: str | None) -> str:
    if story_id:
        for key in story_keys(dev_status):
            if key == story_id or key.startswith(story_id + "-"):
                return key
        die(f"No story matching '{story_id}'")

    in_progress_epics = {
        k.split("-")[1]
        for k, v in dev_status.items()
        if re.fullmatch(r"epic-\d+", k) and v == "in-progress"
    }

    candidates = [k for k in story_keys(dev_status) if dev_status[k] == "backlog"]
    if not candidates:
        die("no backlog stories remaining")

    if in_progress_epics:
        for key in candidates:
            if key.split("-", 1)[0] in in_progress_epics:
                return key
    return candidates[0]


def cmd_resolve(args) -> None:
    status = load_status()
    dev = status["development_status"]
    story_key = pick_story(dev, args.story_id)

    parts = story_key.split("-")
    epic_num, story_num = parts[0], parts[1]
    story_short = f"{epic_num}.{story_num}"

    epic_files = list(EPICS_DIR.glob(f"epic-{epic_num}-*.md"))
    if not epic_files:
        die(f"no epic file for epic {epic_num}")
    epic_file = epic_files[0]

    text = epic_file.read_text()
    # Sharded epics use `## Story X.Y:`; the original monolithic epics.md used `###`.
    pattern = re.compile(
        rf"^#{{2,3}} Story {re.escape(story_short)}:\s*(.+?)$(.*?)(?=^#{{2,3}} Story |\Z)",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(text)
    if not m:
        die(f"story '{story_short}' not found in {epic_file.name}")
    title = m.group(1).strip()
    body = m.group(2)
    acs = extract_acs(body)

    if not acs:
        die(
            f"no acceptance criteria found for story {story_short} in {epic_file.name}"
        )

    print(json.dumps({
        "story_key": story_key,
        "story_short": story_short,
        "epic_num": epic_num,
        "title": title,
        "current_status": dev[story_key],
        "epic_file": str(epic_file.relative_to(REPO)),
        "acceptance_criteria": acs,
        "spec_path": f"_bmad-output/implementation-artifacts/{story_key}.md",
    }, indent=2))


# ---------------------------------------------------------------- worktree


def cmd_worktree(args) -> None:
    worktrees_dir = REPO / ".worktrees"
    worktrees_dir.mkdir(parents=True, exist_ok=True)
    worktree = worktrees_dir / args.story_key
    branch = f"story/{args.story_key}"

    if worktree.exists():
        die(f"worktree path already exists: {worktree}")

    rc = subprocess.run(
        ["git", "rev-parse", "--verify", branch],
        cwd=REPO, capture_output=True,
    )
    if rc.returncode == 0:
        die(f"branch '{branch}' already exists — clean up before retry")

    subprocess.check_call(["git", "fetch", "origin", "main"], cwd=REPO)
    subprocess.check_call(
        ["git", "worktree", "add", str(worktree), "-b", branch, "origin/main"],
        cwd=REPO,
    )
    print(json.dumps({"worktree": str(worktree), "branch": branch}))


# ---------------------------------------------------------------- status


_ALLOWED_STATUSES = {
    "backlog", "ready-for-dev", "in-progress", "review", "done",
    "optional",  # retrospectives
    "in-progress",  # epics
}


def cmd_set_status(args) -> None:
    if args.new_status not in _ALLOWED_STATUSES:
        die(f"illegal status '{args.new_status}'")
    status = load_status()
    if args.key not in status["development_status"]:
        die(f"unknown key '{args.key}'")
    old = status["development_status"][args.key]
    status["development_status"][args.key] = args.new_status
    save_status(status)
    print(json.dumps({"key": args.key, "from": old, "to": args.new_status}))


# ---------------------------------------------------------------- AC gate


def cmd_verify_ac_table(args) -> None:
    """Hard gate. results.json: [{ac, test, result, evidence}, ...]"""
    data = json.loads(Path(args.results).read_text())
    if not isinstance(data, list) or not data:
        die("AC results must be a non-empty list")

    failed = [
        r for r in data
        if str(r.get("result", "")).strip().lower() not in {"pass", "green", "ok"}
    ]
    if failed:
        sys.stderr.write(f"FAIL: {len(failed)}/{len(data)} ACs not green\n")
        for r in failed:
            sys.stderr.write(f"  - {r.get('ac')!r}: {r.get('result')}\n")
        sys.exit(1)
    print(json.dumps({"passed": len(data)}))


# ---------------------------------------------------------------- PR body


def cmd_pr_body(args) -> None:
    info = json.loads(Path(args.resolve_json).read_text())
    results = json.loads(Path(args.results).read_text())

    rows = "\n".join(
        f"| {r.get('ac','').strip()} | {r.get('test','').strip()} | {r.get('result','').strip()} | {r.get('evidence','').strip()} |"
        for r in results
    )

    body = f"""## Summary
Ships story {info['story_short']} — {info['title']}.

## Story
[{info['story_key']}]({info['spec_path']}) (from {info['epic_file']})

## Acceptance Criteria Verification

| AC | Test(s) | Result | Evidence |
|----|---------|--------|----------|
{rows}

## Reviewer
Approved by `bmad-code-review` (pass {args.review_passes} of 3)

🤖 Shipped via `/ship-story`
"""
    print(body)


# ---------------------------------------------------------------- run state


def cmd_record(args) -> None:
    payload = {
        "ts": dt.datetime.now(dt.timezone.utc).isoformat(),
        "event": args.event,
    }
    if args.data:
        try:
            payload["data"] = json.loads(args.data)
        except json.JSONDecodeError:
            payload["data"] = args.data
    with run_log(args.story_key).open("a") as f:
        f.write(json.dumps(payload) + "\n")
    print(json.dumps({"recorded": args.event}))


def cmd_state(args) -> None:
    log = run_log(args.story_key)
    if not log.exists():
        print(json.dumps({"events": []}))
        return
    events = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
    if args.get:
        match = [e for e in events if e["event"] == args.get]
        print(json.dumps(match[-1] if match else None))
    else:
        print(json.dumps({"events": events, "last": events[-1] if events else None}))


# ---------------------------------------------------------------- entry


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("preflight").set_defaults(func=cmd_preflight)

    r = sub.add_parser("resolve")
    r.add_argument("story_id", nargs="?")
    r.set_defaults(func=cmd_resolve)

    w = sub.add_parser("worktree")
    w.add_argument("story_key")
    w.set_defaults(func=cmd_worktree)

    s = sub.add_parser("set-status")
    s.add_argument("key")
    s.add_argument("new_status")
    s.set_defaults(func=cmd_set_status)

    v = sub.add_parser("verify-ac-table")
    v.add_argument("results")
    v.set_defaults(func=cmd_verify_ac_table)

    pr = sub.add_parser("pr-body")
    pr.add_argument("resolve_json", help="JSON file from `resolve` step")
    pr.add_argument("results", help="AC verification results JSON")
    pr.add_argument("review_passes", type=int)
    pr.set_defaults(func=cmd_pr_body)

    rec = sub.add_parser("record")
    rec.add_argument("story_key")
    rec.add_argument("event")
    rec.add_argument("--data", default=None)
    rec.set_defaults(func=cmd_record)

    st = sub.add_parser("state")
    st.add_argument("story_key")
    st.add_argument("--get", default=None, help="return latest event of this name")
    st.set_defaults(func=cmd_state)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
