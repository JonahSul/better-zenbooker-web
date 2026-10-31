import {z} from 'zod/v3';
import {signPurposeProof,verifyPurposeProof} from './consent-proof';
export const ELEMENT_REGISTRY_VERSION='element-v2';
export const PUBLIC_MEASUREMENT_ROUTES=['/','/book','/appointments','/contact','/privacy','/terms'] as const;
export const ELEMENT_DOCUMENT_TTL_MS=30*60000,ELEMENT_RETENTION_MS=30*86400000,ELEMENT_REGISTRATION_LIMIT=30,ELEMENT_ENTRY_LIMIT=600;
export const ELEMENT_TIMING_METRIC='element_document',ELEMENT_DOCUMENT_HEADER='X-Measurement-Document';
export const elementRegistry=[
 {id:'home_heading',route:'/',placement:'hero',kinds:['view']},
 {id:'home_book_header',route:'/',placement:'header',kinds:['view','action']},
 {id:'home_book_hero',route:'/',placement:'hero',kinds:['view','action']},
 {id:'home_contact_header',route:'/',placement:'header',kinds:['view','action']},
 {id:'home_services_heading',route:'/',placement:'services',kinds:['view']},
 {id:'home_service_1',route:'/',placement:'services',kinds:['view','action']},
 {id:'home_service_2',route:'/',placement:'services',kinds:['view','action']},
 {id:'home_service_3',route:'/',placement:'services',kinds:['view','action']},
 {id:'home_service_4',route:'/',placement:'services',kinds:['view','action']},
 {id:'home_coverage_heading',route:'/',placement:'coverage',kinds:['view']},
 {id:'home_request_heading',route:'/',placement:'request',kinds:['view']},
 {id:'home_request_form',route:'/',placement:'request',kinds:['view','action']},
 {id:'book_heading',route:'/book',placement:'main',kinds:['view']},
 {id:'book_offerings',route:'/book',placement:'services',kinds:['view','action']},
 {id:'book_external',route:'/book',placement:'booking',kinds:['view','action']},
 {id:'appointments_heading',route:'/appointments',placement:'main',kinds:['view']},
 {id:'appointments_contact',route:'/appointments',placement:'main',kinds:['view','action']},
 {id:'contact_heading',route:'/contact',placement:'main',kinds:['view']},
 {id:'contact_form',route:'/contact',placement:'contact',kinds:['view','action']},
 {id:'contact_faq_1',route:'/contact',placement:'questions',kinds:['view','action']},
 {id:'contact_faq_2',route:'/contact',placement:'questions',kinds:['view','action']},
 {id:'contact_book',route:'/contact',placement:'questions',kinds:['view','action']},
 {id:'privacy_heading',route:'/privacy',placement:'main',kinds:['view']},
 {id:'terms_heading',route:'/terms',placement:'main',kinds:['view']},
 ] as const;
export type ElementId=typeof elementRegistry[number]['id'];
export type ElementRoute=typeof PUBLIC_MEASUREMENT_ROUTES[number];
const ids=elementRegistry.map(item=>item.id) as [ElementId,...ElementId[]];
export const elementEventInput=z.object({elementId:z.enum(ids),kind:z.enum(['view','action'])}).strict().refine(value=>elementRegistry.some(item=>item.id===value.elementId&&(item.kinds as readonly string[]).includes(value.kind)));
export type ElementEvent=z.infer<typeof elementEventInput>;
export function allowedElementEvent(route:string,event:ElementEvent){return elementEventInput.safeParse(event).success&&elementRegistry.some(item=>item.id===event.elementId&&item.route===route);}
const epoch=z.number().int().safe().nonnegative(),hash=z.string().regex(/^[a-f0-9]{64}$/),version=z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);
export const elementDescriptorInput=z.object({purpose:z.literal('element-document-v1'),workspaceId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),route:z.enum(PUBLIC_MEASUREMENT_ROUTES),snapshotHash:hash,assetManifestHash:hash,rendererVersion:version,registryVersion:z.literal(ELEMENT_REGISTRY_VERSION),issuedAt:epoch,expiresAt:epoch}).strict().refine(value=>value.expiresAt-value.issuedAt===ELEMENT_DOCUMENT_TTL_MS);
export type ElementDescriptor=z.infer<typeof elementDescriptorInput>;
export const elementDocumentInput=z.object({documentKey:z.string().uuid(),descriptor:z.string().min(1).max(4096),experimentReference:z.string().min(1).max(4096).optional()}).strict();
export const elementEventsInput=z.object({documentId:z.string().uuid(),events:z.array(elementEventInput).min(1).max(20)}).strict();
export const elementReportInput=z.object({from:epoch.optional(),to:epoch.optional(),route:z.enum(PUBLIC_MEASUREMENT_ROUTES).optional()}).strict().refine(value=>value.from===undefined&&value.to===undefined||value.from!==undefined&&value.to!==undefined&&value.from<value.to&&value.to-value.from<=31*86400000);
export function resolveElementReportWindow(input:unknown,now=Date.now()){const parsed=elementReportInput.parse(input),to=parsed.to??now,from=parsed.from??Math.max(0,to-7*86400000);if(to>now)throw new Error('invalid_window');return {from,to,route:parsed.route??null};}
export async function signElementDescriptor(value:ElementDescriptor,secret:string){return signPurposeProof(elementDescriptorInput.parse(value),secret,'element-document:v1');}
export async function verifyElementDescriptor(value:string,secret:string|undefined,now=Date.now()):Promise<ElementDescriptor|null>{const parsed=elementDescriptorInput.safeParse(await verifyPurposeProof(value,secret,'element-document:v1'));return parsed.success&&parsed.data.issuedAt<=now&&parsed.data.expiresAt>now?parsed.data:null;}
