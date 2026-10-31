import {z} from 'zod/v3';
export const analyticsSource=z.enum(['ga4','search_console']);
export const analyticsScope=z.enum(['ga4_property','production_search']);
export const analyticsProjectId=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const domain=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
export function validAnalyticsResource(source:'ga4'|'search_console',resource:string){if(source==='ga4')return /^properties\/[1-9][0-9]{0,19}$/.test(resource);if(resource.startsWith('sc-domain:'))return domain.test(resource.slice(10));try{const url=new URL(resource);return url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&!url.search&&domain.test(url.hostname)&&url.port==='';}catch{return false;}}
export const analyticsResource=z.string().min(1).max(2048);
export const trustedSnapshotBinding=z.object({projectId:analyticsProjectId,source:analyticsSource,resource:analyticsResource,scope:analyticsScope}).strict().refine(value=>validAnalyticsResource(value.source,value.resource)&&value.scope===(value.source==='ga4'?'ga4_property':'production_search'));
export const trustedSnapshotBindings=z.array(trustedSnapshotBinding).min(1).max(16);
export function assertTrustedSnapshotSource(value:{searcherriesProjectId:number;source:'ga4'|'search_console';resource:string;scope?:'ga4_property'|'production_search'},configured:string|undefined){if(!configured||configured.length>16384)throw new Error('Analytics import bindings are not configured');let bindings:z.infer<typeof trustedSnapshotBindings>;try{bindings=trustedSnapshotBindings.parse(JSON.parse(configured));}catch{throw new Error('Analytics import bindings are not configured');}const scope=value.scope??(value.source==='ga4'?'ga4_property':'production_search');if(!bindings.some(binding=>binding.projectId===value.searcherriesProjectId&&binding.source===value.source&&binding.resource===value.resource&&binding.scope===scope))throw new Error('Analytics snapshot source is outside this installation binding');return {scope};}

export function configuredSnapshotBindings(configured:string|undefined){try{return trustedSnapshotBindings.parse(JSON.parse(configured??''));}catch{return [];}}
