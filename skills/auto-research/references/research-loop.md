# Parent-controlled iteration

Understand → protocol → optional baseline/evaluator → review design → select subquestions → gather evidence/experiment → evaluate → review → decide → report. This is a method, not a separate scheduler or fixed multi-agent pipeline.

Delegate independent subquestions in a bounded parallel `subagent.tasks` call when useful. Supply goal, subquestion, protocol version, source excerpts/paths, constraints and expected structured output. Same-role instances may investigate theory, candidate datasets, failure cases or competing explanations. Keep coupled computations in the parent. Respect existing four-task parallel, depth-two and ten-minute child deadline limits and the narrower generic execution budget.

After every experiment, save parameters, input/data/evaluator digests, environment, random seed, outputs, objective metrics, uncertainty and run/artifact references. Keep a ledger of completed IDs. A retry checks existing durable results first. Save pending work without pretending it finished.

Stop when objective success and no blockers coexist; when coverage is sufficient and repeated rounds add no material evidence/improvement; when runtime or experiment budgets exhaust; or when required data/approval is missing. Record an explicit stop reason and remaining gaps. Resume in the original conversation from state.json and saved results; no unattended execution guarantee.
