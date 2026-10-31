import {z} from 'zod/v3';
export const curationStages=['budget','transport','normalization','json','schema','redaction','target','evidence','persistence'] as const;
export function curationUsage(value:unknown){const parsed=z.object({usage:z.object({prompt_tokens:z.number().int().min(0).optional(),completion_tokens:z.number().int().min(0).optional(),total_tokens:z.number().int().min(0).optional()})}).safeParse(value);return parsed.success?parsed.data.usage:null;}
