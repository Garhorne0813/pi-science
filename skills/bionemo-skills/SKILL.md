---
name: bionemo-skills
description: Integrate NVIDIA BioNeMo Agent Toolkit life-science skills (protein folding, molecular docking, generative chemistry, genomics, protein design) into this workspace. Use when the user wants GPU-accelerated structure prediction or chemistry tooling beyond the local kernel skills, mentions BioNeMo/NIM, or asks to add NVIDIA's life-science skill pack. Guides the two supported paths — installing the CC-BY-4.0 skill pack into .pi/skills/, or running the NeMo Agent Toolkit FastMCP server and registering it as a custom MCP connector — plus GPU/environment preflight and safety checks. Nothing is downloaded or connected until the user confirms.
version: 0.1.0
license: Apache-2.0
category: structural-biology
requirements: []
risk: high
third_party:
  - kind: service
    name: NVIDIA BioNeMo Agent Toolkit (skills CC-BY-4.0, code Apache-2.0)
    provider: NVIDIA
    license: CC-BY-4.0 / Apache-2.0
    info_url: https://github.com/NVIDIA-BioNeMo/bionemo-agent-toolkit
  - kind: service
    name: NVIDIA NeMo Agent Toolkit (Apache-2.0, FastMCP server runtime)
    provider: NVIDIA
    license: Apache-2.0
    info_url: https://github.com/NVIDIA/NeMo-Agent-Toolkit
---

# BioNeMo Agent Toolkit integration

Bring NVIDIA's life-science agent skills into this workspace on the user's
explicit request only. Both paths are opt-in; nothing is installed or
connected without confirmation.

## Preflight (always, before any install)

1. Ask the user which path they want (skills pack vs MCP server) and why —
   the right choice depends on whether they already run a GPU host or NIM
   endpoints.
2. Check the environment in the session kernel: `nvidia-smi` availability,
   CUDA version, free disk (the stack is large), and Python 3.11–3.13 for the
   NeMo Agent Toolkit.
3. State the network destinations involved before any download: GitHub
   (skill sources), PyPI (packages), and NVIDIA NIM endpoints if the user
   configures them. Sequences sent to remote NIM endpoints leave this machine.

## Path A — skill pack into `.pi/skills/`

The toolkit's skills are plain agent skills (CC-BY-4.0) and can be copied
into the workspace:

1. With the user's confirmation, clone the pinned release:
   `git clone --depth 1 https://github.com/NVIDIA-BioNeMo/bionemo-agent-toolkit`
   (record the commit you used in your summary).
2. Review what will be copied — skill folders, their SKILL metadata, and any
   scripts — and show the user the list and licenses before copying.
3. Copy the chosen skill folders into `.pi/skills/`, then verify they appear
   in Settings → Skills before using them.
4. Heavy dependencies each skill declares stay optional: run the skill's
   preflight (it will check its own requirements) and report what is missing
   rather than bulk-installing.

## Path B — NeMo Agent Toolkit as a custom MCP connector

For serving the skills' workflows as tools through MCP:

1. Install per the NeMo Agent Toolkit docs (`pip install` / `uv` — follow the
   repo's current instructions; do not guess commands).
2. Start its FastMCP server per the official docs, on the user's machine or
   GPU host, and confirm the URL/port with the user.
3. Register it in Settings → MCP → Add custom connector (Streamable HTTP or
   stdio, whichever the server exposes); keep the tool decision on "Ask" so
   every remote call stays user-approved.
4. After connecting, list the discovered tools and summarize what each one
   sends over the network before the first use.

## Safety rules

- BioNeMo workloads often involve unpublished sequences or proprietary
  compounds: remind the user that NIM/remote endpoints receive that data,
  and prefer local GPU execution when available.
- Keep attribution: results produced through BioNeMo skills should name the
  skill and the toolkit version/commit in the summary.
- If any preflight fails (no GPU, no disk, wrong Python), stop and report —
  do not partially install and hope.
