import app, { handlePr } from "../src/app";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "probot";
import * as analyzer from "../src/analyze/analyzer";

const CONTRACT = `version: 1
rules:
  - id: no-direct-sql
    type: pattern
    severity: error
    description: "All database writes must go through the repository layer."
    match:
      patterns: ["INSERT INTO"]
      paths: ["**/*.ts"]
`;

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function loadHandler(): (ctx: unknown) => Promise<void> {
  let handler: ((ctx: unknown) => Promise<void>) | undefined;
  app({
    on: (_events: unknown, h: (ctx: unknown) => Promise<void>) => {
      handler = h;
    },
  } as never);
  if (!handler) throw new Error("handler was not registered");
  return handler;
}

function makeContext(opts: {
  files: { filename: string; content: string }[];
  existingComments?: { id: number; body?: string }[];
}) {
  const createComment = vi.fn().mockResolvedValue({});
  const updateComment = vi.fn().mockResolvedValue({});
  const deleteComment = vi.fn().mockResolvedValue({});
  const listComments = vi.fn().mockResolvedValue({ data: opts.existingComments ?? [] });

  const contentByPath: Record<string, string> = {};
  for (const f of opts.files) contentByPath[f.filename] = f.content;

  const octokit = {
    rest: {
      repos: {
        getContent: vi.fn(async ({ path }: { path: string }) => {
          if (path === "archsentry.yml")
            return { data: { content: b64(CONTRACT), size: Buffer.byteLength(CONTRACT) } };
          const src = contentByPath[path];
          if (src !== undefined)
            return { data: { content: b64(src), size: Buffer.byteLength(src) } };
          throw new Error("not found: " + path);
        }),
      },
      pulls: {
        listFiles: vi.fn().mockResolvedValue({
          data: opts.files.map((f) => ({ filename: f.filename, status: "modified" })),
        }),
      },
      issues: { createComment, updateComment, deleteComment, listComments },
    },
  };

  const context = {
    payload: {
      repository: { owner: { login: "o" }, name: "r" },
      pull_request: { number: 7, base: { sha: "b" }, head: { sha: "h" } },
    },
    octokit,
  };

  return { context, createComment, updateComment, deleteComment };
}

describe("ArchSentry GitHub App", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OLLAMA_MODEL", "");
  });

  it("registers a webhook handler", () => {
    expect(typeof loadHandler()).toBe("function");
  });

  it("posts a comment when a changed file violates a rule", async () => {
    const { context, createComment, updateComment } = makeContext({
      files: [{ filename: "src/user.ts", content: 'const q = "INSERT INTO users";' }],
    });
    await handlePr(context as unknown as Context);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(updateComment).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("no-direct-sql") }),
    );
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("<!-- archsentry -->") }),
    );
  });

  it("updates an existing comment instead of duplicating it", async () => {
    const { context, createComment, updateComment } = makeContext({
      files: [{ filename: "src/user.ts", content: 'const q = "INSERT INTO users";' }],
      existingComments: [{ id: 99, body: "<!-- archsentry -->\nold" }],
    });
    await handlePr(context as unknown as Context);
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 99 }));
    expect(createComment).not.toHaveBeenCalled();
  });

  it("deletes a stale comment when there are no violations", async () => {
    const { context, createComment, deleteComment } = makeContext({
      files: [{ filename: "src/user.ts", content: "const x = 1;" }],
      existingComments: [{ id: 42, body: "<!-- archsentry -->\nold violation" }],
    });
    await handlePr(context as unknown as Context);
    expect(deleteComment).toHaveBeenCalledTimes(1);
    expect(deleteComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 42 }));
    expect(createComment).not.toHaveBeenCalled();
  });

  it("does nothing when no contract is present", async () => {
    const createComment = vi.fn();
    const context = {
      payload: {
        repository: { owner: { login: "o" }, name: "r" },
        pull_request: { number: 7, base: { sha: "b" }, head: { sha: "h" } },
      },
      octokit: {
        rest: {
          repos: { getContent: vi.fn().mockRejectedValue(new Error("404")) },
          pulls: { listFiles: vi.fn() },
          issues: { createComment, listComments: vi.fn().mockResolvedValue({ data: [] }) },
        },
      },
    };
    await handlePr(context as unknown as Context);
    expect(createComment).not.toHaveBeenCalled();
  });

  it("posts a single comment listing multiple violations", async () => {
    const { context, createComment } = makeContext({
      files: [
        { filename: "src/a.ts", content: 'const q = "INSERT INTO a";' },
        { filename: "src/b.ts", content: 'const w = "INSERT INTO b";' },
      ],
    });
    await handlePr(context as unknown as Context);
    expect(createComment).toHaveBeenCalledTimes(1);
    const body = createComment.mock.calls[0]?.[0]?.body as string;
    expect(body).toContain("src/a.ts");
    expect(body).toContain("src/b.ts");
  });

  it("posts a comment with a template fallback when the explainer errors", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
    const { context, createComment } = makeContext({
      files: [{ filename: "src/user.ts", content: 'const q = "INSERT INTO users";' }],
    });
    await handlePr(context as unknown as Context);
    vi.unstubAllGlobals();
    expect(createComment).toHaveBeenCalledTimes(1);
    const body = createComment.mock.calls[0]?.[0]?.body as string;
    expect(body).toContain("repository layer");
  });

  it("posts a non-blocking warning when the scan throws", async () => {
    const spy = vi
      .spyOn(analyzer, "analyzeSources")
      .mockRejectedValueOnce(new Error("scan crashed"));
    const { context, createComment } = makeContext({
      files: [{ filename: "src/user.ts", content: "const x = 1;" }],
    });
    await handlePr(context as unknown as Context);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("could not complete the scan") }),
    );
    spy.mockRestore();
  });

  it("warns and skips when the PR exceeds the file cap", async () => {
    vi.stubEnv("ARCHSENTRY_MAX_FILES", "1");
    const { context, createComment } = makeContext({
      files: [
        { filename: "src/a.ts", content: "const x = 1;" },
        { filename: "src/b.ts", content: "const y = 2;" },
      ],
    });
    await handlePr(context as unknown as Context);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("exceeds the scan size cap") }),
    );
    vi.unstubAllEnvs();
  });

  it("fails closed (warns) when a changed file is unreadable (403/404)", async () => {
    const createComment = vi.fn().mockResolvedValue({});
    const context = {
      payload: {
        repository: { owner: { login: "o" }, name: "r" },
        pull_request: { number: 7, base: { sha: "b" }, head: { sha: "h" } },
      },
      octokit: {
        rest: {
          repos: {
            getContent: vi.fn(({ path }: { path: string }) => {
              if (path === "archsentry.yml")
                return Promise.resolve({ data: { content: b64(CONTRACT) } });
              const e = new Error("Forbidden") as NodeJS.ErrnoException & { status?: number };
              e.status = 403;
              return Promise.reject(e);
            }),
          },
          pulls: {
            listFiles: vi.fn().mockResolvedValue({
              data: [{ filename: "src/user.ts", status: "modified" }],
            }),
          },
          issues: {
            createComment,
            listComments: vi.fn().mockResolvedValue({ data: [] }),
            updateComment: vi.fn(),
            deleteComment: vi.fn(),
          },
        },
      },
    };
    await handlePr(context as unknown as Context);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("could not fully scan") }),
    );
  });
});
