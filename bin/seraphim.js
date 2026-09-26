#!/usr/bin/env node
import { main } from '../src/main.ts';

process.stdout.write(`${main(process.argv.slice(2))}\n`);
