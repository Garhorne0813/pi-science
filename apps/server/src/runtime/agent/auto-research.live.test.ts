import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT, NodeExecutionEnv, type AgentHarnessToolInvocation } from "@earendil-works/pi-agent-core/node";
import { executionBudgetTools } from "./worker/execution-budget.js";
import { promptOperationId } from "./agent-message.js";
import { ModelResourceService } from "../../model-resources/model-resource-service.js";
import { configPath, metadataRoot, writeJsonAtomic } from "../../storage/persistence.js";
import { executionRepository } from "../executions/execution-repository.js";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import { AgentSessionRegistry } from "./agent-session-registry.js";
import { AgentSessionRepository } from "./agent-session-repository.js";
import { openHiddenTask, runHiddenPrompt } from "./hidden-agent-task.js";
import { seedWorkspaceAssets } from "./runtime-config.js";

// Paid, opt-in product acceptance. The same bounded tasks compare ordinary
// Conversation with Skill guidance; this is not a universal research benchmark.
it.skipIf(process.env.PI_SCIENCE_RESEARCH_LIVE_TEST !== "1")("compares real DeepSeek numerical and literature research with and without the Skill", async () => {
  if (!process.env.DEEPSEEK_API_KEY || process.platform !== "linux") throw new Error("Linux sandbox and DEEPSEEK_API_KEY required");
  const outputRoot = resolve("../../.runtime/live-tests"); await mkdir(outputRoot, { recursive: true });
  const root = await mkdtemp(join(outputRoot, "skill-native-")); const previousHome = process.env.PI_SCIENCE_HOME; const previousMode = process.env.PI_SCIENCE_EXECUTION_MODE;
  process.env.PI_SCIENCE_HOME = join(root, "private-state"); process.env.PI_SCIENCE_EXECUTION_MODE = "required";
  const manager = new AgentRuntimeManager(); const observations: Array<Record<string, unknown>> = [];
  try {
    const resources = new ModelResourceService();
    const provider = await resources.createProvider({ name: "DeepSeek research acceptance", adapter: "openai-compatible", catalog_mode: "manual", auth_kind: "api_key", enabled: true });
    const credential = await resources.credentials.put({ kind: "api_key", backend: "environment", environment_variable: "DEEPSEEK_API_KEY" });
    const endpoint = await resources.createEndpoint({ name: "DeepSeek official", base_url: "https://api.deepseek.com/v1", protocol: "openai", credential_ref: credential.id, enabled: true, data_egress: "remote" });
    await resources.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 1 });
    const modelId = "deepseek-flash"; await resources.updateModel(provider.id, modelId, { enabled: true, capabilities: { reasoning: false, context_window: 128000 } });
    await writeJsonAtomic(configPath("config.json"), { model: `${provider.id}/${modelId}`, thinking: "off" });
    for (const task of ["numerical", "literature"] as const) for (const skill of [false, true]) {
      const key = `${task}-${skill ? "skill" : "plain"}`; const cwd = join(root, key); await mkdir(cwd); await mkdir(join(cwd, ".pi-science")); seedWorkspaceAssets(cwd);
      await mkdir(join(cwd, ".pi/agents"), { recursive: true });
      await writeFile(join(cwd, ".pi/agents/experimenter.md"), "---\nname: experimenter\ndescription: bounded candidate implementation\ntools: [bash]\n---\nExecute only the assigned candidate task. Return actual Execution/Artifact references, no self-reported score.");
      const study = join(cwd, "research/study"); await mkdir(join(study, "evaluator"), { recursive: true });
      const evaluator = "import json,sys,pathlib,hashlib,math\ntarget=3\nprotocol_version=1\nscore=lambda p:(p-target)**2\nassert score(target)==0 and score(target-1)==1\ntry: score('invalid'); raise AssertionError('invalid input accepted')\nexcept TypeError: pass\npred=json.loads(pathlib.Path(sys.argv[1]).read_text())['prediction']\nassert isinstance(pred,(float,int)) and math.isfinite(pred)\nresult={'loss':score(pred),'validity':True,'protocol_version':protocol_version,'evaluator_digest':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'data_digest':hashlib.sha256(str(target).encode()).hexdigest(),'environment':sys.version}\npathlib.Path(sys.argv[2]).write_text(json.dumps(result))\nprint(json.dumps(result))\n";
      if (task === "numerical") {
        await writeFile(join(study, "evaluator/evaluate.py"), evaluator); await writeFile(join(study, "baseline-input.json"), '{"prediction":0}');
        for (const id of ["one", "two", "three"]) { await mkdir(join(study, `candidates/${id}/input`), { recursive: true }); await mkdir(join(study, `candidates/${id}/work`)); }
      }
      const runtime = await openHiddenTask(manager, key, { cwd, sessionsRoot: join(metadataRoot(cwd), "agent-sessions"), model: { provider: provider.id, modelId }, env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY }, thinking: "off", allowedTools: task === "numerical" ? ["read", "write", "bash", "subagent", "execution_budget"] : ["read", "write", "execution_budget"], skillPolicy: skill ? { mode: "allowlist", skills: ["auto-research"] } : { mode: "none" } }, "live-research-owner");
      // Test setup provisions the same bounded budget for both modes. The model
      // still performs every delegation, execution, evaluation and evidence write.
      if (task === "numerical") {
        const env = new NodeExecutionEnv({ cwd });
        try { await executionBudgetTools(cwd).tool.execute("setup", { research_id: "study", max_seconds: 360, max_executions: 30 }, () => {}, { env }, { operationId: promptOperationId(runtime.sessionId, key) } as AgentHarnessToolInvocation, BACKGROUND_CONTEXT); }
        finally { await env.cleanup(BACKGROUND_CONTEXT); }
      }
      const agent = skill ? "auto-research/experimenter" : "experimenter";
      const numerical = `Bounded known-answer numerical acceptance, not open-ended research. The exact case-sensitive agent name is ${agent}. Every subagent request MUST use agent=${JSON.stringify(agent)} and candidate_id (singular). Do not use Experimenter, researcher, runner or probe any other agent. The test setup has already bound research_id=study to a 360-second/30-call production budget for this operation; inspect it with execution_budget if needed. A task-specific evaluator already exists at research/study/evaluator/evaluate.py; use it with ordinary Parent Bash. First write evaluation.yaml describing protocol v1, squared error, minimize, target loss=0, three rounds and fixed data. Validate its embedded known-answer tests by running baseline: python3 -I research/study/evaluator/evaluate.py research/study/baseline-input.json research/study/baseline.json. Then do exactly three candidate rounds via subagent ${agent}, candidate_id one/two/three and predictions 1/2/3. For candidate one ask the child to deliberately run 'echo repair-needed >&2; exit 7' once, observe failure, then repair by writing predictions.json containing {"prediction":1} in its work directory. Other children write predictions.json with their assigned prediction. Tell every child: Bash starts in your own work directory. Write only predictions.json using a relative filename, never a research/... path. Run exactly the assigned command(s), return the actual references immediately, and do not probe files or search for logs/IDs. The successful write command is: printf '{"prediction":N}' > predictions.json, substituting its assigned N. The first child makes just the deliberate failing call and this repair call; the others make only this write call. After each child, Parent runs the same evaluator with research/study/candidates/<id>/work/predictions.json and output research/study/result-<id>.json. Do not use Candidate self-reported metrics. After three rounds, create evaluator/v2.py from v1 changing target=3 to target=4 and protocol_version=1 to protocol_version=2, then reevaluate candidate three into research/study/result-v2.json. Treat v1 and v2 scores as incomparable, not evidence of a regression/improvement. Save manifest.json with real Execution/Artifact refs for completed v1 experiments using source parent_tool, Use only manifest root fields schema_version=1, research_id, revision, candidates, executions, experiments. All three indexes MUST be objects keyed by IDs, never arrays. Do not add baseline/v2 root fields; keep their details in results/state/report. Candidate entries have path=candidates/<id> and hypothesis; execution entries have candidate_id and artifact_refs [{artifact_id,version}]; each experiment has a distinct experiment ID, candidate_id, hypothesis, protocol_version=1, execution_ids, result_path=experiments/<experiment-id>/result.json, status=completed, evaluation={source:parent_tool,execution_id,result_artifact:{artifact_id,version},evaluator_digest,data_digest}. Its evaluation execution must be indexed for the same Candidate and contain that result Artifact. Save result details at the recorded experiment paths. Also save a checkpoint state.json with manifest revision, next action=stop and version-change explanation. Write report.md with actual baseline/round losses, failed-run/repair evidence, versions, incompatibility, actual references and remaining limits. Stop on unexpected failures; no host fallback or registry setup.`;
      const literature = "Use only these supplied source excerpts; no network retrieval or computation. source-001 DOI 10.0000/example-a: an observational study reports correlation between exposure and outcome; confounding remains. source-002 DOI 10.0000/example-b: an independent randomized trial reports no clear effect and wide uncertainty. These are synthetic test excerpts, not real papers; label them as such. Investigate whether causal benefit is established, preserve the two identifiers, contrast methods, state uncertainty and counterevidence. Write research/study/report.md and a qualitative evaluation.yaml/checkpoint. Do not create a numerical evaluator, score or Experimenter, and do not invent citations. Use normal files/conversation tools only; stop with a qualified conclusion.";
      const started = Date.now(); let report = ""; let failure: string | undefined;
      try { report = await runHiddenPrompt(runtime, `${skill ? "/skill:auto-research " : ""}${task === "numerical" ? numerical : literature}`, key, Date.now() + 420_000); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      const executions = await executionRepository.list(cwd); const savedReport = await readFile(join(study, "report.md"), "utf8").catch(() => "");
      let losses: number[] | undefined;
      const validate = async () => {
        if (failure) throw new Error(failure);
        expect(report.trim()).not.toBe("");
        if (task === "numerical") {
          const results = await Promise.all(["baseline", "result-one", "result-two", "result-three", "result-v2"].map(async (name) => JSON.parse(await readFile(join(study, `${name}.json`), "utf8"))));
          const publications = (await readFile(join(metadataRoot(cwd), "artifacts.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
          for (const [index, name] of ["baseline", "result-one", "result-two", "result-three", "result-v2"].entries()) {
            const artifact = publications.findLast((item) => item.path === `research/study/${name}.json`);
            expect(artifact).toBeDefined();
            const execution = executions.find((item) => item.execution_id === artifact.producer.execution_id)!;
            expect(execution).toMatchObject({ status: "succeeded", producer: "bash", runtime: { execution_mode: "required" } });
            expect((execution.request.command as string[]).join(" ")).toContain(index === 4 ? "evaluator/v2.py" : "evaluator/evaluate.py");
            expect(execution.artifacts).toContainEqual(expect.objectContaining({ artifact_id: artifact.artifact_id, version: artifact.version }));
            const bytes = await readFile(join(metadataRoot(cwd), "artifact-content", artifact.sha256));
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
            expect(JSON.parse(bytes.toString())).toEqual(results[index]);
          }
          losses = results.map((item) => item.loss); expect(losses).toEqual([9, 4, 1, 0, 1]);
          expect(new Set(results.slice(0, 4).map((item) => item.evaluator_digest)).size).toBe(1); expect(results[4].evaluator_digest).not.toBe(results[0].evaluator_digest); expect(results[4].protocol_version).toBe(2);
          expect(savedReport).toMatch(/incompar|不可比|different.*version/i); expect(executions.some((item) => item.status === "failed")).toBe(true);
          const validator = new URL("../../../../../skills/auto-research/scripts/validate-manifest.mjs", import.meta.url).href;
          const { validateManifest } = await import(validator);
          const manifest = JSON.parse(await readFile(join(study, "manifest.json"), "utf8")); validateManifest(manifest);
          expect(Object.values(manifest.experiments).filter((item: any) => item.status === "completed")).toHaveLength(3);
          for (const [id, entry] of Object.entries(manifest.executions) as Array<[string, { artifact_refs: Array<{ artifact_id: string; version: number }> }]>) {
            const actual = executions.find((item) => item.execution_id === id); expect(actual).toBeDefined();
            for (const ref of entry.artifact_refs) expect(actual!.artifacts).toContainEqual(expect.objectContaining(ref));
          }
        } else {
          expect(savedReport).toContain("10.0000/example-a"); expect(savedReport).toContain("10.0000/example-b"); expect(savedReport).toMatch(/synthetic|虚构|合成/i); expect(executions).toHaveLength(0);
          await expect(readFile(join(study, "evaluator/evaluate.py"))).rejects.toThrow();
        }
      };
      let manifestRepairs = 0; let initialFailure: string | undefined;
      try { await validate(); } catch (error) {
        initialFailure = error instanceof Error ? error.message : String(error);
        if (task === "numerical" && initialFailure.includes("Invalid research manifest:")) {
          try {
            manifestRepairs++;
            await runHiddenPrompt(runtime, `Read-only review found ${initialFailure}. Repair only manifest.json using normal read/write tools and the Skill manifest template/protocol. candidates/executions/experiments MUST be ID-keyed objects, never arrays. Root keys are only schema_version, research_id, revision, candidates, executions, experiments. Preserve real IDs and result evidence; scientific details belong in result files. Do not execute or delegate anything, do not rerun measurements. Then confirm the correction.`, `${key}-manifest-repair`, Date.now() + 90_000);
            await validate(); expect(await executionRepository.list(cwd)).toHaveLength(executions.length);
          } catch (repairError) { failure = repairError instanceof Error ? repairError.message : String(repairError); }
        } else failure = initialFailure;
      }
      const ids = Object.keys(await new AgentSessionRegistry().all(cwd)); const repository = new AgentSessionRepository();
      const stats = await Promise.all(ids.map((id) => repository.stats(cwd, id)));
      const messages = (await Promise.all(ids.map((id) => repository.messages(cwd, id)))).flat();
      observations.push({ task, skill, status: failure ? "incomplete" : "passed", failure, initial_failure: initialFailure, manifest_repairs: manifestRepairs, final_response: report, report: savedReport, elapsed_ms: Date.now() - started, losses, tool_calls: stats.reduce((sum, item) => sum + (item?.toolCalls ?? 0), 0), tokens: (await repository.stats(cwd, runtime.sessionId))?.tokens.total ?? 0, failed_tool_calls: messages.filter((item) => item.isError).length, failed_executions: executions.filter((item) => item.status === "failed").length, executions: executions.length });
      await manager.stop(key); await writeFile(join(outputRoot, "auto-research-comparison.json"), JSON.stringify(observations, null, 2));
    }
    console.info("Live research comparison:", JSON.stringify(observations.map(({ report: _report, final_response: _response, ...summary }) => summary)));
    expect(observations).toHaveLength(4);
    expect(observations.every((item) => item.status === "passed")).toBe(true);
  } finally {
    await manager.shutdownAll(); if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME; else process.env.PI_SCIENCE_HOME = previousHome;
    if (previousMode === undefined) delete process.env.PI_SCIENCE_EXECUTION_MODE; else process.env.PI_SCIENCE_EXECUTION_MODE = previousMode; await rm(root, { recursive: true, force: true });
  }
}, 1_200_000);
