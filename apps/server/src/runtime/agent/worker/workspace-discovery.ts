import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { setImmediate } from "node:timers/promises";
import ignore, { type Ignore } from "ignore";
import picomatch from "picomatch";
import type { RE2 } from "re2-wasm";
import { workspaceReadBoundary, workspaceSkillResources } from "../../sandbox/workspace-read-authorization.js";
import { isWithin } from "../../sandbox/policy.js";
import { readRegularFile } from "../../sandbox/file-read.js";
import { directory } from "./workspace-discovery-directory.js";
import { operatorExecutionMode } from "../../sandbox/policy.js";

import { DiscoveryError, discoveryBackendAvailable, type Operation, type DiscoveryInput, type DiscoveryResult } from "./workspace-discovery-contract.js";
export { DiscoveryError, discoveryBackendAvailable } from "./workspace-discovery-contract.js";
export type { Operation, DiscoveryInput } from "./workspace-discovery-contract.js";

export function discoveryPath(cwd: string, input: string) {
  if (!input || input.includes("\0") || input.includes("\\") || isAbsolute(input) || win32.isAbsolute(input) || /^[a-z]:/i.test(input) || input.split("/").includes("..")) throw new DiscoveryError("invalid_input");
  return resolve(cwd, input);
}
function matcher(pattern: string) {
  if (pattern.includes("\0") || pattern.includes("\\") || pattern.startsWith("/") || /^[a-z]:/i.test(pattern) || pattern.split("/").includes("..")) throw new DiscoveryError("invalid_input");
  // Extglobs, negation and regex groups are outside the public glob contract.
  if (pattern.startsWith("!") || /[()]/.test(pattern)) throw new DiscoveryError("unsupported_pattern");
  try { return picomatch(pattern, { strictBrackets: true, dot: false, noext: true, nonegate: true }); }
  catch { throw new DiscoveryError("unsupported_pattern"); }
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
// eslint-disable-next-line no-control-regex -- Explicitly strip terminal control bytes from untrusted text.
const clean = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const preview = (value: string, matchIndex: number) => {
  // re2-wasm reports indexes in Unicode code points, including astral characters.
  // Map the original match to sanitized text so removed controls cannot shift it
  // outside the window. Keep allocations bounded by the existing file budget.
  let units = 0, position = 0;
  for (const character of value) { if (position++ >= matchIndex) break; units += character.length; }
  let before = 0;
  for (const _character of clean(value.slice(0, units))) before++;
  const start = Math.max(0, before - 128);
  let result = "", length = 0; position = 0;
  for (const character of clean(value)) {
    if (position++ < start) continue;
    if (length++ === 512) break;
    result += character;
  }
  return { column: matchIndex + 1, text: result };
};
const MAX_FILE = 8 * 1024 * 1024;

export async function discover(operation: Operation, cwd: string, input: DiscoveryInput, signal?: AbortSignal, skillFiles: string[] = []) {
  if (!discoveryBackendAvailable()) throw new DiscoveryError("tool_unavailable");
  try { operatorExecutionMode(); } catch { throw new DiscoveryError("tool_unavailable"); }
  const start = performance.now();
  const checkpoint = () => {
    if (signal?.aborted) throw new DiscoveryError("cancelled");
    if (performance.now() - start >= 5000) throw new DiscoveryError("timeout");
  };
  checkpoint();
  const requested = discoveryPath(cwd, input.path ?? ".");
  const pi = join(cwd, ".pi"); const skills = join(pi, "skills");
  // Explicit navigation is required: ordinary workspace searches never descend
  // into .pi. Recursive searches of .pi itself would include unrelated config.
  const resourceRequest = input.path !== undefined && isWithin(pi, requested);
  if (resourceRequest && requested === pi && operation !== "ls") throw new DiscoveryError("access_denied");
  const resources = resourceRequest ? workspaceSkillResources(cwd, skillFiles) : { files: [], directories: [] };
  const skillRoots = resources.files;
  const ignoreRoot = resourceRequest ? resources.directories.find(root => isWithin(root, requested)) ?? skills : cwd;
  const boundary = await workspaceReadBoundary("discovery", skillRoots).catch(() => { throw new DiscoveryError("tool_unavailable"); });
  const authorize = (path: string) => { try { return boundary(path, cwd); } catch { throw new DiscoveryError("access_denied"); } };
  const target = authorize(requested);
  const pathOf = (path: string) => relative(cwd, path).replaceAll("\\", "/");
  const allowed = (path: string) => { try { authorize(path); return true; } catch { return false; } };
  const pattern = operation === "glob" ? matcher(input.pattern!) : input.glob ? matcher(input.glob) : undefined;
  let regex: RE2 | undefined;
  if (operation === "grep") {
    const { RE2 } = await import("re2-wasm");
    if (["\r", "\n", "\0"].some((character) => input.pattern!.includes(character))) throw new DiscoveryError("unsupported_pattern");
    try { regex = new RE2(input.literal ? input.pattern!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.pattern!, input.ignoreCase ? "iu" : "u"); }
    catch { throw new DiscoveryError("unsupported_pattern"); }
  }
  let visited = 0, scanned = 0;
  let truncationReason: "limit" | "bytes" | "scan_budget" | undefined;
  const entries: Array<{ path: string; type: "file" | "directory" }> = [];
  const files: string[] = [];
  const matches: NonNullable<DiscoveryResult["matches"]> = [];
  const resultItems = operation === "ls" ? entries : operation === "glob" ? files : matches;
  let outputBytes = 256;
  const push = (value: typeof resultItems[number]) => {
    if (resultItems.length >= input.limit) { truncationReason = "limit"; return false; }
    const size = Buffer.byteLength(JSON.stringify(value)) + 1;
    if (outputBytes + size > 64 * 1024) { truncationReason = "bytes"; return false; }
    outputBytes += size;
    (resultItems as unknown[]).push(value); return true;
  };
  const read = async (path: string, maximum: number) => {
    authorize(path); checkpoint();
    const bytes = await readRegularFile(path, maximum); checkpoint(); authorize(path);
    return bytes;
  };
  const search = async (path: string) => {
    checkpoint();
    const name = pathOf(path);
    if (pattern && !pattern(relative(target, path).replaceAll("\\", "/") || name.split("/").at(-1)!)) return;
    if (operation === "glob") { push(name); return; }
    let bytes: Buffer;
    try {
      const info = await lstat(path);
      if (info.size > MAX_FILE) { truncationReason ??= "scan_budget"; return; }
      if (scanned + info.size > 64 * 1024 * 1024) throw new DiscoveryError("resource_limit");
      bytes = await read(path, Math.min(MAX_FILE, 64 * 1024 * 1024 - scanned));
      scanned += bytes.length;
    } catch (error) {
      if (error instanceof DiscoveryError) throw error;
      // A failed capture is not evidence of a complete search with no matches.
      // Abort directory searches too, rather than silently hiding missing data.
      throw new DiscoveryError((error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "access_denied");
    }
    if (bytes.includes(0)) return;
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return; }
    // Do not allocate an array of every line in a large file.
    let offset = 0, line = 1;
    while (offset < text.length) {
      const end = text.indexOf("\n", offset);
      const value = text.slice(offset, end < 0 ? text.length : end).replace(/\r$/, "");
      const match = regex!.exec(value);
      if (match) {
        authorize(path);
        if (!push({ path: name, line, ...preview(value, match.index) })) return;
      }
      offset = end < 0 ? text.length : end + 1; line++;
      if (line % 128 === 0) { await setImmediate(); checkpoint(); }
    }
  };
  type Rule = { base: string; rules: Ignore };
  const ignored = (rules: Rule[], path: string, dir = false) => {
    let excluded = false;
    for (const rule of rules) {
      const decision = rule.rules.test(relative(rule.base, path).replaceAll("\\", "/") + (dir ? "/" : ""));
      if (decision.ignored) excluded = true;
      if (decision.unignored) excluded = false;
    }
    return excluded;
  };
  const readIgnore = async (parent: string) => {
    // Ignore metadata is consumed as policy only. It is never published or searched.
    authorize(parent); checkpoint();
    const bytes = await readRegularFile(resolve(parent, ".gitignore"), 64 * 1024);
    scanned += bytes.length;
    if (scanned > 64 * 1024 * 1024) throw new DiscoveryError("resource_limit");
    checkpoint(); return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  };
  const walk = async (path: string, depth: number, inherited: Rule[]): Promise<void> => {
    checkpoint(); if (depth > 20) throw new DiscoveryError("resource_limit");
    await directory(path, async (pinned) => {
      let rules = inherited;
      if (operation !== "ls") {
        try {
          rules = [...rules, { base: path, rules: ignore().add(await readIgnore(path)) }];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error instanceof DiscoveryError ? error : new DiscoveryError("access_denied");
        }
      }
      const children: Array<{ name: string; dir: boolean }> = [];
      for await (const name of pinned.names(20_001 - visited)) {
        checkpoint(); if (++visited > 20_000) throw new DiscoveryError("resource_limit");
        const child = resolve(path, name);
        if (!allowed(child) || name.startsWith(".")) continue;
        const info = await pinned.stat(name);
        if (!(info.directory || info.file && info.nlink === 1)) continue;
        const dir = info.directory;
        if (operation !== "ls" && ignored(rules, child, dir)) continue;
        children.push({ name, dir });
      }
      children.sort((a, b) => compare(a.name + (a.dir ? "/" : ""), b.name + (b.dir ? "/" : "")));
      for (const child of children) {
        checkpoint();
        const absolute = resolve(path, child.name);
        if (!allowed(absolute)) continue;
        // Reopen via the pinned parent before publishing names.
        const info = await pinned.stat(child.name);
        if (child.dir ? !info.directory : !info.file || info.nlink !== 1) throw new DiscoveryError("access_denied");
        if (operation === "ls") { if (!push({ path: pathOf(absolute) + (child.dir ? "/" : ""), type: child.dir ? "directory" : "file" })) return; }
        else if (child.dir) await walk(absolute, depth + 1, rules);
        else await search(absolute);
        if (truncationReason === "limit" || truncationReason === "bytes") return;
      }
    });
  };
  try {
    // Ancestor ignore rules also apply when a narrower path is requested.
    const inherited: Rule[] = [];
    const parents: string[] = [];
    for (let parent = dirname(target); parent !== dirname(ignoreRoot) && isWithin(ignoreRoot, parent); parent = dirname(parent)) parents.unshift(parent);
    if (target !== ignoreRoot && operation !== "ls") for (const parent of parents) {
      try { inherited.push({ base: parent, rules: ignore().add(await readIgnore(parent)) }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error instanceof DiscoveryError ? error : new DiscoveryError("access_denied");
      }
    }
    const info = await lstat(target);
    if (info.isDirectory()) { if (target === cwd || operation === "ls" || !ignored(inherited, target, true)) await walk(target, 0, inherited); }
    else if (operation === "grep" && info.isFile() && info.nlink === 1) {
      if (!ignored(inherited, target)) await directory(dirname(target), async () => search(target));
    } else throw new DiscoveryError("access_denied");
    checkpoint();
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError((error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "access_denied");
  }
  const finalBoundary = await workspaceReadBoundary("discovery", skillRoots).catch(() => { throw new DiscoveryError("tool_unavailable"); });
  const finalPaths = new Map<string, Array<{ path: string; directory: boolean }>>();
  for (const item of resultItems) {
    const name = typeof item === "string" ? item : item.path;
    const absolute = resolve(cwd, name);
    const parent = dirname(absolute);
    const group = finalPaths.get(parent) ?? [];
    group.push({ path: absolute, directory: typeof item !== "string" && "type" in item && item.type === "directory" });
    finalPaths.set(parent, group);
  }
  try {
    for (const [parent, group] of finalPaths) await directory(parent, async (pinned) => {
      for (const item of group) {
        checkpoint(); finalBoundary(item.path, cwd);
        const info = await pinned.stat(relative(parent, item.path));
        if (item.directory ? !info.directory : !info.file || info.nlink !== 1) throw new DiscoveryError("access_denied");
      }
    });
  } catch (error) { throw error instanceof DiscoveryError ? error : new DiscoveryError("access_denied"); }
  // Recursive traversal order and path lexicographic order coincide for ordinary
  // components; sort again for punctuation and prefix edge cases.
  entries.sort((a, b) => compare(a.path, b.path)); files.sort(compare);
  matches.sort((a, b) => compare(a.path, b.path) || a.line - b.line);
  checkpoint();
  const result: DiscoveryResult = { ...(operation === "ls" ? { entries } : operation === "glob" ? { files } : { matches }), truncated: !!truncationReason, limit: input.limit, ...(truncationReason ? { truncationReason } : {}) };
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { operation, result, truncated: result.truncated, ...(truncationReason ? { truncationReason } : {}) } };
}
