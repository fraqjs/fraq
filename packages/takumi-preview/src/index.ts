#!/usr/bin/env node

import { runCli } from './cli';

await runCli(process.argv.slice(2));
