# Project-local skills

Put custom skills in `.lsd/skills/<skill-name>/SKILL.md`.

Example:

```text
.lsd/
  skills/
    example-skill/
      SKILL.md
```

These skills are auto-discovered by LSD and can be invoked as:

```text
/skill:example-skill
```

If a skill needs more structure, you can add optional subfolders like:

- `references/` — supporting docs the skill can point to
- `workflows/` — step-by-step procedures
- `templates/` — reusable output templates
- `scripts/` — executable helper scripts
