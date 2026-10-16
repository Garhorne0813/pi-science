# Optional protected evaluation — deferred RFC

Ordinary Auto Research is Skill-native: the Parent validates and versions task-specific scripts, runs them through existing sandboxed Bash/Notebook, and records real Execution/Artifact/Provenance evidence. Candidate input/work isolation and generic protected-root policy remain runtime responsibilities.

A previous PR #159 prototype introduced an operator registry, frozen evaluator revisions, approval, a dedicated runner/tool and query quotas. That implementation and its test evidence remain in git history through `5188f9ad`; it is removed from the default product rather than maintained as an unused subsystem. Existing Execution/Artifact records remain readable, and historical manifest references may be retained without enabling execution.

Hiding holdout data from the Parent or preventing a malicious Parent from changing evaluation rules requires an independent trusted boundary. If that becomes a real product requirement, design and approve it separately. Do not claim those guarantees for ordinary local Parent evaluation or make protected scoring a prerequisite for the Skill.

Any future design must specify actors, data secrecy, operator authority, immutable inputs, result privacy, resource limits and supported-platform acceptance. This RFC adds no runtime service or configuration requirement.
