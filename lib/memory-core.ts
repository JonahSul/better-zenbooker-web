import {z} from 'zod/v3';
export const memoryNamespace=z.enum(['interaction','curation']);
export const memoryProvenance=z.object({source:z.enum(['manual','chat','analysis']),sourceId:z.string().uuid().nullable().default(null),window:z.object({from:z.number().int().nonnegative(),to:z.number().int().positive()}).strict().nullable().default(null)}).strict();
export const memoryAdd=z.object({namespace:memoryNamespace,title:z.string().trim().min(3).max(100),content:z.string().trim().min(3).max(4000),provenance:memoryProvenance.default({source:'manual',sourceId:null,window:null})}).strict();
export const memoryEdit=memoryAdd.omit({namespace:true}).extend({nodeId:z.string().uuid(),revision:z.number().int().positive()}).strict();
export const memoryIdentity=z.object({nodeId:z.string().uuid(),revision:z.number().int().positive()}).strict();
export const memoryList=z.object({namespace:memoryNamespace,query:z.string().max(100).default(''),deleted:z.boolean().default(false),limit:z.number().int().min(1).max(100).default(50)}).strict();
export const memoryLink=z.object({fromId:z.string().uuid(),toId:z.string().uuid(),relation:z.enum(['supports','relates_to','supersedes'])}).strict().refine(v=>v.fromId!==v.toId);
