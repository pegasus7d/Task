// apps/server/src/data/dataset-loader.ts
//
// Reads test-evals/data/{transcripts,gold,schema}.* from disk and produces a
// content-addressed DatasetManifest. Idempotent — same files always produce
// the same dataset_hash + schema_hash.

import { readFile, readdir } from "node:fs/promises";
import { join, basename, resolve } from "node:path";

import type { CaseId, Sha256Hex } from "@test-evals/db/repositories";

import { canonicalJson, sha256 } from "../utils/hash";
import { ClinicalExtractionSchema, type ClinicalExtraction } from "./clinical-schema";

export interface CaseRecord {
  case_id:    CaseId;
  transcript: string;
  tokens:     number;
  tags:       string[];
  gold:       ClinicalExtraction;
}

export interface DatasetManifest {
  dataset_hash: Sha256Hex;
  schema_hash:  Sha256Hex;
  case_count:   number;
  cases:        CaseRecord[];
}

/** Repository root resolved relative to this file: ../../../../ → test-evals/. */
function dataDir(): string {
  return resolve(import.meta.dir, "../../../../data");
}

/** Cheap token approximation — 1 token ≈ 4 chars. Good enough for V1 budget math. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export async function loadDataset(): Promise<DatasetManifest> {
  const root          = dataDir();
  const transcriptDir = join(root, "transcripts");
  const goldDir       = join(root, "gold");
  const schemaPath    = join(root, "schema.json");

  const [schemaRaw, transcriptFiles] = await Promise.all([
    readFile(schemaPath, "utf8"),
    readdir(transcriptDir),
  ]);

  const txtFiles = transcriptFiles.filter((f) => f.endsWith(".txt")).sort();

  const cases: CaseRecord[] = await Promise.all(
    txtFiles.map(async (file): Promise<CaseRecord> => {
      const caseId    = basename(file, ".txt");
      const txtPath   = join(transcriptDir, file);
      const goldPath  = join(goldDir, `${caseId}.json`);
      const [transcript, goldRaw] = await Promise.all([
        readFile(txtPath, "utf8"),
        readFile(goldPath, "utf8"),
      ]);
      const goldParsed = JSON.parse(goldRaw);
      const gold       = ClinicalExtractionSchema.parse(goldParsed);
      return {
        case_id:    caseId,
        transcript,
        tokens:     approxTokens(transcript),
        tags:       [],
        gold,
      };
    }),
  );

  const datasetHash = sha256(canonicalJson(cases.map((c) => ({
    case_id: c.case_id, transcript: c.transcript, gold: c.gold,
  }))));
  const schemaHash  = sha256(schemaRaw);

  return {
    dataset_hash: datasetHash,
    schema_hash:  schemaHash,
    case_count:   cases.length,
    cases,
  };
}
