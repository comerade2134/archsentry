import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Contract, Rule } from "./types";

export function parseContract(raw: string): Contract {
  const data = parse(raw) as Partial<Contract> | null;
  if (!data || typeof data !== "object") {
    throw new Error("Config is not a valid YAML object.");
  }
  if (typeof data.version !== "number") {
    throw new Error(`Config missing required numeric "version".`);
  }
  if (!Array.isArray(data.rules) || data.rules.length === 0) {
    throw new Error(`Config must contain a non-empty "rules" array.`);
  }

  for (const r of data.rules as Rule[]) {
    if (!r.id || typeof r.id !== "string") throw new Error(`Each rule needs a string "id".`);
    if (!r.type || typeof r.type !== "string") throw new Error(`Rule "${r.id}" missing "type".`);
    if (!r.description || typeof r.description !== "string") {
      throw new Error(`Rule "${r.id}" missing "description".`);
    }
  }

  return { version: data.version, rules: data.rules as Rule[] };
}

export function loadContract(path: string): Contract {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`Could not read config at "${path}": ${(e as Error).message}`);
  }
  return parseContract(raw);
}
