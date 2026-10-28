// Exercise the nested helper as well as the outer Bubblewrap namespace.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const runtimeRoot = resolve(dirname(require.resolve("@anthropic-ai/sandbox-runtime")), "..");
const helper = resolve(runtimeRoot, "vendor/seccomp", process.arch, "apply-seccomp");
execFileSync("bwrap", [
  "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-net",
  "--cap-drop", "ALL", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
  "--", helper, "/bin/true",
], { stdio: "inherit", timeout: 10_000 });
console.log("Bubblewrap and nested seccomp helper startup passed");
