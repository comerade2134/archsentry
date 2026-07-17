import { describe, it, expect } from "vitest";
import { loadContract, parseContract, ConfigError } from "../src/config/loader";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

function tmp(name: string, content: string): string {
  const p = join(process.cwd(), "test", name);
  writeFileSync(p, content);
  return p;
}

describe("loadContract / parseContract", () => {
  it("loads a valid contract with a pattern rule", () => {
    const p = tmp(
      ".tmp-valid.yml",
      'version: 1\nrules:\n  - id: r1\n    type: pattern\n    description: d\n    match:\n      patterns: ["x"]\n',
    );
    const c = loadContract(p);
    expect(c.version).toBe(1);
    expect(c.rules[0]?.id).toBe("r1");
    rmSync(p);
  });

  it("throws when rules array is empty", () => {
    const p = tmp(".tmp-empty.yml", "version: 1\nrules: []\n");
    expect(() => loadContract(p)).toThrow(ConfigError);
    rmSync(p);
  });

  it("throws when a rule lacks a description", () => {
    const p = tmp(
      ".tmp-nodec.yml",
      'version: 1\nrules:\n  - id: r1\n    type: pattern\n    match:\n      patterns: ["x"]\n',
    );
    expect(() => loadContract(p)).toThrow(/description/);
    rmSync(p);
  });

  it("throws on an invalid severity", () => {
    const p = tmp(
      ".tmp-sev.yml",
      'version: 1\nrules:\n  - id: r1\n    type: pattern\n    severity: critical\n    description: d\n    match:\n      patterns: ["x"]\n',
    );
    expect(() => loadContract(p)).toThrow(/severity/);
    rmSync(p);
  });

  it("throws on an unsupported rule type", () => {
    const p = tmp(
      ".tmp-type.yml",
      "version: 1\nrules:\n  - id: r1\n    type: regex\n    description: d\n",
    );
    expect(() => loadContract(p)).toThrow(/type/);
    rmSync(p);
  });

  it("throws when a pattern rule has no match.patterns", () => {
    const p = tmp(
      ".tmp-match.yml",
      "version: 1\nrules:\n  - id: r1\n    type: pattern\n    description: d\n",
    );
    expect(() => loadContract(p)).toThrow(/match\.patterns/);
    rmSync(p);
  });

  it("throws when a semgrep rule has no semgrep mapping", () => {
    const p = tmp(
      ".tmp-sg.yml",
      "version: 1\nrules:\n  - id: r1\n    type: semgrep\n    description: d\n",
    );
    expect(() => loadContract(p)).toThrow(/semgrep/);
    rmSync(p);
  });

  it("throws when the root is not a mapping", () => {
    expect(() => parseContract("- just\n- a\n- list\n")).toThrow(ConfigError);
  });

  it("throws on a missing version", () => {
    const p = tmp(
      ".tmp-ver.yml",
      'rules:\n  - id: r1\n    type: pattern\n    description: d\n    match:\n      patterns: ["x"]\n',
    );
    expect(() => loadContract(p)).toThrow(/version/);
    rmSync(p);
  });
});
