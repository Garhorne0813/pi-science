// Dependency-free launcher probe. The wall-clock timer covers connecting,
// headers and the entire response body, even when bytes arrive continuously.
import http from "node:http";

const deadline = !process.argv[3] ? Infinity : Number(process.argv[3]) * 1000;
const timeout = Math.min(2000, deadline - Date.now());
if (!(timeout > 0)) process.exit(1);
let request;
const timer = setTimeout(() => finish(1), timeout);
function finish(code) {
  clearTimeout(timer);
  request?.destroy();
  process.exit(code);
}
try {
  request = http.get(process.argv[2], { agent: false }, (response) => {
    if (response.statusCode >= 400) return finish(1);
    response.on("error", () => finish(1));
    response.on("aborted", () => finish(1));
    response.on("end", () => finish(0));
    response.resume();
  });
  request.on("error", () => finish(1));
} catch {
  finish(1);
}
