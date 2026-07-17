import type { Violation } from "../engine/types";

export interface Explainer {
  explain(v: Violation, codeContext: string): Promise<string>;
}

const SYSTEM_PROMPT =
  "You are ArchSentry, a concise code-review bot. Explain to a developer, in 2-3 plain sentences, " +
  "why an architectural rule was violated and how to fix it. Reference the specific code. No preamble.";

function buildPrompt(v: Violation, codeContext: string): string {
  return (
    `${SYSTEM_PROMPT}\n\n` +
    `Rule: ${v.ruleId} (${v.severity})\n` +
    `${v.message}\n\n` +
    `Offending code at line ${v.line}:\n${codeContext}`
  );
}

// OpenAI-compatible chat API (OpenAI itself, or any OpenAI-compatible endpoint
// such as OpenRouter). Selected when OPENAI_API_KEY or OPENROUTER_API_KEY is set.
export class OpenAIExplainer implements Explainer {
  constructor(
    private apiKey: string,
    private model = "gpt-4o-mini",
    private baseUrl = "https://api.openai.com/v1",
    private extraHeaders: Record<string, string> = {},
  ) {}

  async explain(v: Violation, codeContext: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: buildPrompt(v, codeContext) }],
        temperature: 0.2,
        max_tokens: 200,
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const content = json.choices[0]?.message?.content;
    if (!content) throw new Error("LLM returned no explanation content");
    return content.trim();
  }
}

// Free local model via Ollama (https://ollama.com). Used when OLLAMA_MODEL is set.
export class OllamaExplainer implements Explainer {
  constructor(
    private model: string,
    private baseUrl = "http://localhost:11434",
  ) {}

  async explain(v: Violation, codeContext: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: buildPrompt(v, codeContext) }],
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { message: { content: string } };
    return json.message.content.trim();
  }
}

// Zero-cost, zero-dependency fallback: derives a remediation hint from the rule.
export class TemplateExplainer implements Explainer {
  async explain(v: Violation): Promise<string> {
    return (
      `${v.message} ` +
      `Move this call behind the appropriate service or repository layer so the access path is centralized ` +
      `and reviewable, rather than issued directly from \`${v.file}\`.`
    );
  }
}

// Picks the strongest explainer available from the environment:
//   OPENAI_API_KEY     -> GPT-4o-mini via OpenAI (best quality, costs money)
//   OPENROUTER_API_KEY -> any OpenRouter model (free tiers available, e.g. Nemotron 3 Ultra)
//   OLLAMA_MODEL       -> local Ollama model (free, private)
//   else               -> TemplateExplainer (free, always works)
export function selectExplainer(): Explainer {
  if (process.env.OPENAI_API_KEY) return new OpenAIExplainer(process.env.OPENAI_API_KEY);
  if (process.env.OPENROUTER_API_KEY) {
    const model = process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free";
    return new OpenAIExplainer(
      process.env.OPENROUTER_API_KEY,
      model,
      "https://openrouter.ai/api/v1",
      { "HTTP-Referer": "https://github.com/archsentry", "X-Title": "ArchSentry" },
    );
  }
  if (process.env.OLLAMA_MODEL) return new OllamaExplainer(process.env.OLLAMA_MODEL);
  return new TemplateExplainer();
}
