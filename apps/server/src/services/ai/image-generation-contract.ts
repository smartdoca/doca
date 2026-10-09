import { z } from "zod";
import { imageBatchAttemptScopeV3Schema } from "./image-batch.js";
import { referenceCropsSchema } from "./image-edit-adapter.js";
import { editRegionsSchema } from "./image-edit-regions.js";

const pointer = z.object({ version:z.literal(1), receiptId:z.string().uuid(), assetId:z.string().uuid(), sha256:z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const paid = z.object({ version:z.literal(3), scope:imageBatchAttemptScopeV3Schema, referenceImageId:z.string().uuid(), ordinal:z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const common = z.object({
  kind:z.literal("image_generation"), version:z.literal(1),
  generationOperationId:z.string().uuid(), resourceId:z.string().uuid().optional(),
  generation:z.object({prompt:z.string().min(2).max(8000),referenceImageIds:z.array(z.string().uuid()).min(1).max(8),editRegions:editRegionsSchema.optional(),referenceCrops:referenceCropsSchema.optional()}).strict(),
  origin:z.enum(["reference-export","local-recomposition"]).optional(),
  paidAttempt:paid.optional(),rawCandidate:pointer.optional(),providerCallId:z.string().uuid().optional(),
  providerImageUsage:z.object({inputImages:z.number().int().nonnegative()}).strict().optional(),
  editMask:z.object({version:z.union([z.literal(1),z.literal(2)]),receiptId:z.string().uuid(),digest:z.string(),maskDigest:z.string()}).strict().optional(),
  preservation:z.json().optional(),localStorage:z.json().optional(),
}).strict();
const saved=common.extend({state:z.literal("saved"),assetId:z.string().uuid(),filename:z.string().min(1).max(255),width:z.number().int().positive(),height:z.number().int().positive(),mime:z.literal("image/png"),size:z.number().int().positive().max(20*1024*1024),ready:z.literal(true),url:z.string(),instruction:z.string()}).strict();
export const imageGenerationV1ReceiptSchema=z.union([saved,common.extend({state:z.enum(["generating","failed","save_failed","composing"])}).strict()]).refine(v=>{
  if(v.origin===undefined) return !!v.paidAttempt && v.paidAttempt.referenceImageId===v.generation.referenceImageIds[0];
  if(v.paidAttempt) return false;
  if(v.origin==="reference-export") return v.generation.referenceImageIds.length===1 && !v.rawCandidate && !v.providerCallId;
  return !!v.rawCandidate;
}).refine(v=>v.state!=="saved"||v.width*v.height<=25_000_000);
export function isSavedGenerationReceipt(value:any):boolean {
  if(value?.kind!=="image_generation")return false;
  if(value.version===1){const parsed=imageGenerationV1ReceiptSchema.safeParse(value);return parsed.success&&parsed.data.state==="saved";}
  // The unchanged historical unversioned receipt keeps its explicit old reader.
  return value.version===undefined && value.state==="saved" && !!value.assetId;
}
