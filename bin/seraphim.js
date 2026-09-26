#!/usr/bin/env node
import { main } from '../src/main.ts';

const args = process.argv.slice(2);
const output = await main(args);

process.stdout.write(`${output}\n`);
