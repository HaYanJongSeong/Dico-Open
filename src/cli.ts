#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

const envPath = resolve('.env');
if (existsSync(envPath)) loadEnvFile(envPath);
const { runCli } = await import('./index.js');
await runCli();
