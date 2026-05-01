// apps/server/src/llm/select-adapter.ts
//
// Returns the LLM adapter to use for a run. Mock by default; real Anthropic
// when ANTHROPIC_API_KEY is set AND USE_ANTHROPIC=1. Mock stays available
// even with a key so tests never hit the network.
//
// Guards against the dummy/placeholder key shape committed in .env.example
// so a misconfigured `USE_ANTHROPIC=1` fails LOUD at boot — not 50 cases in.

import { mockLLMAdapter } from "./mock-adapter";
import { AnthropicAdapter } from "./anthropic-adapter";
import type { ILLMAdapter } from "./types";

/** Patterns that indicate a placeholder / dummy key. Keep this list short. */
const PLACEHOLDER_PATTERNS = [
  /REPLACE_ME/i,
  /YOUR[_-]?KEY/i,
  /DUMMY/i,
  /PLACEHOLDER/i,
  /example/i,
];

function isPlaceholderKey(key: string): boolean {
  if (key.length < 30) return true;                          // real keys are ~110 chars
  if (!key.startsWith("sk-ant-")) return true;               // real keys start with sk-ant-
  return PLACEHOLDER_PATTERNS.some((p) => p.test(key));
}

export function selectAdapter(): ILLMAdapter {
  const useReal = process.env.USE_ANTHROPIC === "1";
  if (!useReal) return mockLLMAdapter;

  const key = process.env.ANTHROPIC_API_KEY ?? "";
  if (!key) {
    throw new Error(
      "[select-adapter] USE_ANTHROPIC=1 but ANTHROPIC_API_KEY is empty. " +
      "Paste a real key into apps/server/.env (line ~10) or set USE_ANTHROPIC=0.",
    );
  }
  if (isPlaceholderKey(key)) {
    throw new Error(
      "[select-adapter] USE_ANTHROPIC=1 but ANTHROPIC_API_KEY looks like a placeholder " +
      `("${key.slice(0, 16)}…"). Replace the dummy key in apps/server/.env with a real ` +
      "sk-ant-api03-... key from https://console.anthropic.com/settings/keys",
    );
  }

  return new AnthropicAdapter({ apiKey: key });
}
