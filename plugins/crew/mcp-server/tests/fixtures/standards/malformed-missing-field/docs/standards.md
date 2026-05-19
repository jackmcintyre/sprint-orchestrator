updated: "2026-05-19"
criteria:
  - name: "story-aligned"
    what: "The PR's diff implements only what the story's acceptance criteria require."
    check: "Map each diff hunk to one or more ACs; flag any hunk that maps to none."
    anti_criterion: "Scope creep: refactors or rewrites that the story did not request."
