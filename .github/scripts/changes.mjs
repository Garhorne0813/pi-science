import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Only human documentation can skip verification. Skill/agent Markdown is
// executable configuration and intentionally does not match this allowlist.
export function requiresVerification(paths) {
  return paths.length === 0 || paths.some((path) => !path.startsWith("docs/") && !/^README(?:\.[^/]+)?\.md$/.test(path));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let run = true;
  const { BASE_SHA, HEAD_SHA, GITHUB_OUTPUT } = process.env;
  if (BASE_SHA && !/^0+$/.test(BASE_SHA) && HEAD_SHA) {
    try {
      const paths = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", BASE_SHA, HEAD_SHA], { encoding: "utf8" }).split("\0").filter(Boolean);
      run = requiresVerification(paths);
    } catch {
      // Missing history (for example after a force push) must run all checks.
    }
  }
  appendFileSync(GITHUB_OUTPUT, `run=${run}\n`);
}
