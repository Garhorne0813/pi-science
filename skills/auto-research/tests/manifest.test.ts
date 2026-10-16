import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { validateManifest } from "../scripts/validate-manifest.mjs";

function fixture() {
  return { schema_version: 1, research_id: "study", revision: 1,
    candidates: { "candidate-1": { path: "candidates/candidate-1", hypothesis: "bounded hypothesis" } },
    executions: { exec_failed: { candidate_id: "candidate-1", artifact_refs: [] }, exec_repair: { candidate_id: "candidate-1", artifact_refs: [{ artifact_id: "prediction", version: 1 }] }, exec_eval: { candidate_id: "candidate-1", artifact_refs: [{ artifact_id: "evaluation", version: 2 }] } },
    experiments: { "experiment-1": { candidate_id: "candidate-1", hypothesis: "controlled test", protocol_version: 1, execution_ids: ["exec_failed", "exec_repair"], result_path: "experiments/experiment-1/result.json", status: "awaiting_evaluation" } } };
}
it("ships an empty valid manifest without fabricated runs or completion state", async () => {
  const template = JSON.parse(await readFile(new URL("../templates/research-manifest.json", import.meta.url), "utf8"));
  expect(validateManifest(template)).toBe(template);
  expect(template.executions).toEqual({}); expect(template.experiments).toEqual({});
});
it("links several repair executions and independently evaluated experiments to one Candidate", () => {
  const manifest: any = fixture();
  expect(validateManifest(manifest)).toBe(manifest);
  const first = manifest.experiments["experiment-1"];
  first.status = "completed"; first.execution_ids.push("exec_eval");
  first.evaluation = { source: "external_operator", execution_id: "exec_eval", result_artifact: { artifact_id: "evaluation", version: 2 }, evaluator_digest: "a".repeat(64), data_digest: "b".repeat(64) };
  manifest.experiments["experiment-2"] = { ...first, protocol_version: 2, status: "planned", execution_ids: [], result_path: "experiments/experiment-2/result.json" }; delete manifest.experiments["experiment-2"].evaluation;
  expect(validateManifest(manifest)).toBe(manifest);
});
it("rejects cross-Candidate/missing executions, duplicate links and unsafe paths", () => {
  for (const mutate of [
    (m: any) => { m.executions.exec_repair.candidate_id = "missing"; },
    (m: any) => { m.candidates.other = { path: "candidates/other", hypothesis: "other" }; m.executions.exec_repair.candidate_id = "other"; },
    (m: any) => { m.experiments["experiment-1"].execution_ids.push("exec_unknown"); },
    (m: any) => { m.experiments["experiment-1"].execution_ids.push("exec_failed"); },
    (m: any) => { m.candidates["candidate-1"].path = "../evaluator"; },
    (m: any) => { m.experiments["experiment-1"].result_path = "experiments/../evaluator.json"; },
    (m: any) => { m.experiments["candidate-1"] = m.experiments["experiment-1"]; },
  ]) { const manifest = fixture(); mutate(manifest); expect(() => validateManifest(manifest)).toThrow("Invalid research manifest"); }
});
it("refuses completion without matching independent evaluation and forbids copied execution status", () => {
  const manifest: any = fixture(); manifest.experiments["experiment-1"].status = "completed";
  expect(() => validateManifest(manifest)).toThrow("fields");
  manifest.experiments["experiment-1"].evaluation = { source: "external_operator", execution_id: "exec_eval", result_artifact: { artifact_id: "evaluation", version: 2 }, evaluator_digest: "a".repeat(64), data_digest: "b".repeat(64) };
  expect(() => validateManifest(manifest)).toThrow("must be linked");
  manifest.experiments["experiment-1"].execution_ids.push("exec_eval");
  expect(validateManifest(manifest)).toBe(manifest);
  manifest.experiments["experiment-1"].evaluation.result_artifact.version = 1;
  expect(() => validateManifest(manifest)).toThrow("does not belong");
  const duplicate: any = fixture(); duplicate.executions.exec_failed.status = "succeeded";
  expect(() => validateManifest(duplicate)).toThrow("fields");
  duplicate.executions.exec_failed = { candidate_id: "candidate-1", artifact_refs: [] }; duplicate.completed_ids = ["experiment-1"];
  expect(() => validateManifest(duplicate)).toThrow("fields");
});
it("can index legacy result paths without renaming evidence or accepting legacy completion flags", () => {
  const manifest = fixture(); manifest.experiments["experiment-1"].result_path = "experiments/candidate-1/result.json";
  expect(validateManifest(manifest)).toBe(manifest);
  expect(manifest.experiments["experiment-1"].status).toBe("awaiting_evaluation");
  const duplicate: any = manifest; duplicate.experiments["experiment-2"] = { ...manifest.experiments["experiment-1"] };
  expect(() => validateManifest(duplicate)).toThrow("shared result_path");
});
