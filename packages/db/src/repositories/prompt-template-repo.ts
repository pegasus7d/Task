// packages/db/src/repositories/prompt-template-repo.ts
//
// Idempotent upsert per prompt_hash. Strategy code changes → new hash → new
// row → old runs still resolve. Required because runs/attempts FK to this.

import { eq } from "drizzle-orm";

import { db } from "../index";
import { promptTemplates } from "../schema/eval";
import { throwIfConstraintViolation } from "./db-errors";
import type { Sha256Hex, StrategyName } from "./types";

export interface PromptTemplateInput {
  prompt_hash:      Sha256Hex;
  strategy_name:    StrategyName;
  template_body:    string;
  tools_hash:       Sha256Hex;
  tool_definitions: unknown;
  schema_hash:      Sha256Hex;
  variables_jsonb?: Record<string, unknown>;
}

export class PromptTemplateRepository {
  async exists(promptHash: Sha256Hex): Promise<boolean> {
    const rows = await db
      .select({ promptHash: promptTemplates.promptHash })
      .from(promptTemplates)
      .where(eq(promptTemplates.promptHash, promptHash))
      .limit(1);
    return rows.length > 0;
  }

  async upsert(input: PromptTemplateInput): Promise<{ inserted: boolean }> {
    if (await this.exists(input.prompt_hash)) return { inserted: false };

    try {
      await db.insert(promptTemplates).values({
        promptHash:      input.prompt_hash,
        strategyName:    input.strategy_name,
        templateBody:    input.template_body,
        toolsHash:       input.tools_hash,
        toolDefinitions: input.tool_definitions as never,
        schemaHash:      input.schema_hash,
        variablesJsonb:  (input.variables_jsonb ?? {}) as never,
      });
      return { inserted: true };
    } catch (e) {
      throwIfConstraintViolation(e);
    }
  }
}
