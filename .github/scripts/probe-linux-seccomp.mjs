// Reuse the deployment diagnostic; this never changes system policy.
import { checkLinuxSeccomp } from "../../scripts/check-linux-sandbox.mjs";
await checkLinuxSeccomp();
console.log("Bubblewrap and nested seccomp helper startup passed");
