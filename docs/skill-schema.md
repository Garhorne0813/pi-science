# Pi-Science Skill Metadata v1

Every skill is a directory containing `SKILL.md`. The file begins with YAML
front matter. `name` and `description` are required; the remaining fields are
optional but should be declared for a skill that calls external services or
needs a non-default runtime.

```yaml
---
name: literature-review
description: Find and verify scientific literature.
version: 0.1.0
license: Apache-2.0
category: research
requirements:
  - name: python
    kind: python
  - name: gpu
    kind: gpu
    optional: true
required_tools: []
required_mcp_tools: [literature.search]
risk: low
third_party:
  - kind: service
    name: Crossref
    license: provider-terms
    info_url: https://www.crossref.org/documentation/retrieve-metadata/
    privacy_url: https://www.crossref.org/operations-and-sustainability/privacy/
entrypoints: []
---
```

`requirements` may use the legacy shorthand `- gpu`; the validator normalizes
it to `{name: gpu, kind: other}`. `third_party` entries are metadata only and
must never contain API keys, SSH keys, or other secrets. A remote service must
declare where data goes and link to its terms/privacy page when available.

Useful commands:

```bash
pi-science skills validate skills/literature-review
pi-science skills validate --strict skills/literature-review
pi-science skills eval skills/literature-review skills/literature-review/tests/fixtures.json
pi-science skills init my-new-skill
```

The API equivalents are `GET /api/skills`, `GET /api/skills/{skill_id}`,
`POST /api/skills/validate`, and `GET /api/sessions/{session_id}/skills`.

