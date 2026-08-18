import { describe, expect, it } from "vitest";

import { formatModelLabel } from "./model-label";

describe("formatModelLabel", () => {
  it("drops the vendor prefix and the release date", () => {
    expect(formatModelLabel("anthropic/claude-sonnet-4-20250514")).toBe(
      "Claude Sonnet 4"
    );
    expect(formatModelLabel("openai/gpt-4o-2024-08-06")).toBe("GPT 4o");
  });

  it("keeps the conventional casing of known tokens", () => {
    expect(formatModelLabel("gpt-4o-mini")).toBe("GPT 4o mini");
    expect(formatModelLabel("o3-preview")).toBe("o3 preview");
    expect(formatModelLabel("qwen-vl-max")).toBe("Qwen VL Max");
  });

  it("leaves provider casing and digit-led segments alone", () => {
    expect(formatModelLabel("deepseek-ai/DeepSeek-V3")).toBe("DeepSeek V3");
    expect(formatModelLabel("qwen2.5-72b-instruct")).toBe(
      "Qwen2.5 72b Instruct"
    );
  });

  it("handles plain IDs, empty input, and separator-only input", () => {
    expect(formatModelLabel("test-model")).toBe("Test Model");
    expect(formatModelLabel("")).toBe("");
    expect(formatModelLabel("  ")).toBe("");
    // Nothing survives the split, so the ID itself is shown rather than an
    // empty label.
    expect(formatModelLabel("--")).toBe("--");
  });

  it("only strips a date that is a trailing suffix", () => {
    expect(formatModelLabel("model-20250514-turbo")).toBe(
      "Model 20250514 Turbo"
    );
    expect(formatModelLabel("gpt-4-32k")).toBe("GPT 4 32k");
  });
});
