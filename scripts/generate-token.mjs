#!/usr/bin/env node
// A file entry avoids Windows PowerShell 5.1's native argument quoting for -e.
import { randomBytes } from "node:crypto";
process.stdout.write(randomBytes(32).toString("hex"));
