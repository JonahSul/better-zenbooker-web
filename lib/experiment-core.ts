import {z} from 'zod/v3';
export const sections=['hero','services','coverage','process','reviews','request','questions'] as const;
export const HARD_RULES={version:'brand-v3-facts-v1',brandLocked:true,contactLocked:true,metadataLocked:true,privateDemo:true,primaryMetric:'saved_preferred_date_request',trafficStage:'demo'} as const;
const copy=(max=200)=>z.string().trim().min(3).max(max).refine(s=>!/[<>]|https?:|@|\$|\d[\d\s().+-]{6,}\d|\b[a-z0-9-]+\.(com|net|org)\b|guarantee|certified|five.star|\bfree\b/i.test(s),'Copy must be plain, factual service guidance without new offers or unsupported claims.');
export const compositionDefinition=z.object({headline:copy(140).optional(),cta:copy(80).optional(),process:z.array(z.object({title:copy(80),text:copy()}).strict()).length(3).optional(),processLayout:z.enum(['cards','steps']).optional(),order:z.array(z.enum(sections)).length(7).refine(v=>new Set(v).size===7&&v[0]==='hero','All sections must occur once, with hero first.').optional()}).strict();
export type CompositionDefinition=z.infer<typeof compositionDefinition>;
export const selectedCompositions=z.array(z.object({label:z.enum(['control','A','B','C','D']),allocation:z.number().int().min(0).max(10000),definition:compositionDefinition}).strict()).min(1).max(5).refine(rows=>rows.reduce((s,r)=>s+r.allocation,0)===10000&&rows.some(r=>r.label==='control'&&r.allocation>0)&&new Set(rows.map(r=>r.label)).size===rows.length,'Allocations total 10000; a positive control and unique labels are required.').refine(rows=>{const control=rows.find(r=>r.label==='control');return !!control&&Object.keys(control.definition).length===0;},'Control preserves the approved baseline.');
export type SelectedCompositions=z.infer<typeof selectedCompositions>;
export function unbiasedBasisPoint(random=()=>crypto.getRandomValues(new Uint32Array(1))[0]){const bound=Math.floor(0x100000000/10000)*10000;for(let i=0;i<100;i++){const n=random();if(Number.isInteger(n)&&n>=0&&n<bound)return n%10000;}throw new Error('Random allocation unavailable');}
export function allocate<T extends {allocation:number}>(rows:T[],point=unbiasedBasisPoint()){if(rows.some(row=>!Number.isInteger(row.allocation)||row.allocation<0||row.allocation>10000)||point<0||point>=10000||!Number.isInteger(point)||rows.reduce((n,r)=>n+r.allocation,0)!==10000)throw new Error('Invalid allocation');let sum=0;for(const row of rows){sum+=row.allocation;if(point<sum)return row;}throw new Error('Invalid allocation');}



