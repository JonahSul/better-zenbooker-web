import {z} from 'zod/v3';
export const managementTargets=z.array(z.object({versionId:z.string().uuid(),managementRevision:z.number().int().min(0)}).strict()).min(1).max(50).refine(rows=>new Set(rows.map(row=>row.versionId)).size===rows.length,'Select each version once');
export const managementMutation=z.object({requestKey:z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/),targets:managementTargets}).strict();
export const managementExport=z.object({targets:managementTargets}).strict();
export type ManagementTarget=z.infer<typeof managementTargets>[number];
export type ManagementAction='archive'|'restore'|'delete';
