import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Read-only structural/link validation. Execution/Artifact stores remain the
// authority; this validator neither executes code nor attests scientific scores.
const fail = (message) => { throw new Error(`Invalid research manifest: ${message}`); };
const object = (value, label) => { if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`); };
const fields = (value, names, label) => { object(value, label); if (Object.keys(value).some((key) => !names.includes(key)) || names.some((key) => !(key in value))) fail(`${label} fields must be ${names.join(", ")}`); };
const text = (value, label) => { if (typeof value !== "string" || !value.trim()) fail(`${label} must be nonempty text`); };
const id = (value, label) => { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) fail(`${label} must be a literal identifier`); };
const version = (value, label) => { if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer`); };
const digest = (value, label) => { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} must be a SHA-256 digest`); };
const owns = (value, key) => Object.hasOwn(value, key);
const artifact = (value) => { fields(value, ["artifact_id", "version"], "artifact reference"); text(value.artifact_id, "artifact_id"); version(value.version, "artifact version"); };
const resultPath = (value) => { if (typeof value !== "string" || !/^experiments\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.json$/.test(value) || value.split("/").some((part) => part === "." || part === "..")) fail("result_path must be a canonical experiments/<id>/<file>.json path"); };

export function validateManifest(manifest) {
  fields(manifest, ["schema_version", "research_id", "revision", "candidates", "executions", "experiments"], "root");
  if (manifest.schema_version !== 1) fail("unsupported schema_version");
  if (typeof manifest.research_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(manifest.research_id)) fail("invalid research_id");
  version(manifest.revision, "revision");
  for (const key of ["candidates", "executions", "experiments"]) object(manifest[key], key);
  for (const [key, candidate] of Object.entries(manifest.candidates)) {
    id(key, "candidate_id"); fields(candidate, ["path", "hypothesis"], "candidate");
    if (candidate.path !== `candidates/${key}`) fail("candidate path does not match its identity");
    text(candidate.hypothesis, "candidate hypothesis");
  }
  for (const [key, execution] of Object.entries(manifest.executions)) {
    if (!/^exec_[A-Za-z0-9_-]+$/.test(key)) fail("invalid execution_id");
    fields(execution, ["candidate_id", "artifact_refs"], "execution");
    if (!owns(manifest.candidates, execution.candidate_id)) fail("execution references an unknown candidate");
    if (!Array.isArray(execution.artifact_refs)) fail("artifact_refs must be an array");
    const seen = new Set();
    for (const ref of execution.artifact_refs) { artifact(ref); const identity = JSON.stringify([ref.artifact_id, ref.version]); if (seen.has(identity)) fail("duplicate artifact reference"); seen.add(identity); }
  }
  const resultPaths = new Set();
  for (const [key, experiment] of Object.entries(manifest.experiments)) {
    id(key, "experiment_id"); object(experiment, "experiment");
    const base = ["candidate_id", "hypothesis", "protocol_version", "execution_ids", "result_path", "status"];
    fields(experiment, experiment.status === "completed" ? [...base, "evaluation"] : base, "experiment");
    if (!owns(manifest.candidates, experiment.candidate_id)) fail("experiment references an unknown candidate");
    if (owns(manifest.candidates, key)) fail("experiment_id must be distinct from candidate IDs");
    text(experiment.hypothesis, "experiment hypothesis"); version(experiment.protocol_version, "protocol_version"); resultPath(experiment.result_path);
    if (resultPaths.has(experiment.result_path)) fail("experiments must not overwrite a shared result_path");
    resultPaths.add(experiment.result_path);
    if (!["planned", "running", "awaiting_evaluation", "completed", "failed", "cancelled", "blocked"].includes(experiment.status)) fail("invalid experiment status");
    if (!Array.isArray(experiment.execution_ids) || new Set(experiment.execution_ids).size !== experiment.execution_ids.length) fail("execution_ids must be a unique array");
    for (const executionId of experiment.execution_ids) if (!owns(manifest.executions, executionId) || manifest.executions[executionId].candidate_id !== experiment.candidate_id) fail("experiment execution is missing or belongs to another candidate");
    if (experiment.status === "completed") {
      const evaluation = experiment.evaluation;
      const evidence = ["source", "execution_id", "result_artifact", "evaluator_digest", "data_digest"];
      if (!["parent_tool", "external_operator", "trusted_evaluator"].includes(evaluation.source)) fail("independent evaluation evidence is required");
      fields(evaluation, evaluation.source === "trusted_evaluator" ? [...evidence, "evaluation_id", "evaluator_revision_id", "environment_revision", "environment_digest", "protocol_revision", "input_sha256"] : evidence, "evaluation");
      if (evaluation.source === "trusted_evaluator") {
        for (const key of ["evaluation_id", "evaluator_revision_id", "environment_revision", "protocol_revision"]) text(evaluation[key], key);
        digest(evaluation.environment_digest, "environment_digest"); digest(evaluation.input_sha256, "input_sha256");
      }
      if (!experiment.execution_ids.includes(evaluation.execution_id)) fail("evaluation execution must be linked to the experiment");
      artifact(evaluation.result_artifact); digest(evaluation.evaluator_digest, "evaluator_digest"); digest(evaluation.data_digest, "data_digest");
      if (!manifest.executions[evaluation.execution_id].artifact_refs.some((ref) => ref.artifact_id === evaluation.result_artifact.artifact_id && ref.version === evaluation.result_artifact.version)) fail("evaluation artifact does not belong to its execution");
    }
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node validate-manifest.mjs <manifest.json>");
    validateManifest(JSON.parse(await readFile(process.argv[2], "utf8")));
    process.stdout.write("Research manifest structure and links are valid; verify actual evidence separately.\n");
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
