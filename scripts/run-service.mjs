#!/usr/bin/env node
// Carry launcher identity in the command line without adding Node execArgv or
// passing unknown options to Vite/tsx. Workers inherit ordinary Node flags only.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const [marker, token, entry, ...args] = process.argv.slice(2);
if (marker !== "--launch-token" || !/^[a-f0-9]{32}$/.test(token ?? "") || !entry) {
  throw new Error("Usage: run-service.mjs --launch-token TOKEN ENTRY [arguments]");
}
process.env.PI_SCIENCE_LAUNCH_TOKEN = token;
process.argv = [process.execPath, resolve(entry), ...args];
await import(pathToFileURL(resolve(entry)).href);
