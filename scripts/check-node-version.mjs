#!/usr/bin/env node
const version = process.argv[2] || process.versions.node;
const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(version);
const supported = Boolean(match) && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 12));
if (!supported) process.exitCode = 1;
