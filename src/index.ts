#!/usr/bin/env node
import { buildCli } from "./cli";

buildCli().parseAsync(process.argv);
