// apps/server/src/data/clinical-schema.ts
//
// Zod schema for ClinicalExtraction (contracts.md §2.1). Single source of
// truth for: (a) Anthropic tool input_schema, (b) post-call validation,
// (c) inferred TypeScript type for the rest of the server code.

import { z } from "zod";

export const VitalsSchema = z.object({
  bp:     z.string().regex(/^[0-9]{2,3}\/[0-9]{2,3}$/).nullable(),
  hr:     z.number().int().min(20).max(250).nullable(),
  temp_f: z.number().min(90).max(110).nullable(),
  spo2:   z.number().int().min(50).max(100).nullable(),
}).strict();
export type Vitals = z.infer<typeof VitalsSchema>;

export const MedicationSchema = z.object({
  name:           z.string().min(1),
  dose:           z.string().nullable(),
  frequency:      z.string().nullable(),
  route:          z.string().nullable(),
  evidence_quote: z.string().min(1).optional(),
}).strict();
export type Medication = z.infer<typeof MedicationSchema>;

export const DiagnosisSchema = z.object({
  description:    z.string().min(1),
  icd10:          z.string().regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/).optional(),
  evidence_quote: z.string().min(1).optional(),
}).strict();
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export const FollowUpSchema = z.object({
  interval_days: z.number().int().min(0).max(730).nullable(),
  reason:        z.string().nullable(),
}).strict();
export type FollowUp = z.infer<typeof FollowUpSchema>;

export const ClinicalExtractionSchema = z.object({
  chief_complaint: z.string().min(1),
  vitals:          VitalsSchema,
  medications:     z.array(MedicationSchema),
  diagnoses:       z.array(DiagnosisSchema),
  plan:            z.array(z.string().min(1)),
  follow_up:       FollowUpSchema,
}).strict();
export type ClinicalExtraction = z.infer<typeof ClinicalExtractionSchema>;
