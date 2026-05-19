# crew

Scaffold — see the PRD at `_bmad-output/planning-artifacts/prd-crew-v1.md`.

## Standards doc

Every reviewer verdict and retrospective reads `<target-repo>/docs/standards.md`. Bootstrap a target repo by copying the shipped template:

```
cp plugins/crew/docs/standards-example.md <target-repo>/docs/standards.md
```

Then edit the criteria for your project. The file is a YAML document with `version`, `updated`, and up to 10 `criteria` (each carrying `name`, `what`, `check`, `anti_criterion`). The full install walkthrough lands in Story 1.7.
