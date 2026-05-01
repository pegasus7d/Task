// apps/server/src/llm/tool-definition.ts
//
// The single Anthropic `extract_clinical` tool. Schema is auto-derived from
// the same Zod that validates outputs (clinical-schema.ts) — keeps the wire
// shape and the validation shape in lockstep.
//
// V1 uses a static JSON Schema rather than the live zod-to-json-schema
// conversion to keep dependencies minimal — the shape is deliberately
// hand-written to mirror data/schema.json exactly.

export const EXTRACT_CLINICAL_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["chief_complaint", "vitals", "medications", "diagnoses", "plan", "follow_up"],
  properties: {
    chief_complaint: { type: "string", minLength: 1 },
    vitals: {
      type: "object", additionalProperties: false,
      required: ["bp", "hr", "temp_f", "spo2"],
      properties: {
        bp:     { type: ["string", "null"], pattern: "^[0-9]{2,3}/[0-9]{2,3}$" },
        hr:     { type: ["integer", "null"], minimum: 20, maximum: 250 },
        temp_f: { type: ["number", "null"],  minimum: 90, maximum: 110 },
        spo2:   { type: ["integer", "null"], minimum: 50, maximum: 100 },
      },
    },
    medications: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "dose", "frequency", "route"],
        properties: {
          name:           { type: "string", minLength: 1 },
          dose:           { type: ["string", "null"] },
          frequency:      { type: ["string", "null"] },
          route:          { type: ["string", "null"] },
          evidence_quote: { type: "string", minLength: 1 },
        },
      },
    },
    diagnoses: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["description"],
        properties: {
          description:    { type: "string", minLength: 1 },
          icd10:          { type: "string", pattern: "^[A-Z][0-9]{2}(\\.[0-9A-Z]{1,4})?$" },
          evidence_quote: { type: "string", minLength: 1 },
        },
      },
    },
    plan:      { type: "array", items: { type: "string", minLength: 1 } },
    follow_up: {
      type: "object", additionalProperties: false,
      required: ["interval_days", "reason"],
      properties: {
        interval_days: { type: ["integer", "null"], minimum: 0, maximum: 730 },
        reason:        { type: ["string", "null"] },
      },
    },
  },
} as const;

export const EXTRACT_CLINICAL_TOOL = {
  name: "extract_clinical",
  description:
    "Record the structured clinical findings from the encounter. " +
    "Use ONLY information present in the transcript. " +
    "If a field is not stated, set it to null. " +
    "For each medical field, populate evidence_quote with the verbatim transcript span.",
  input_schema: EXTRACT_CLINICAL_INPUT_SCHEMA,
} as const;
