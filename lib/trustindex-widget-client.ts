import {publicReviewsUrlInput,safePublicReviewsUrl} from './public-reviews-url';
import {z} from 'zod/v3';
const id=z.string().regex(/^[A-Za-z0-9]{1,128}$/);
const configSchema=z.object({revision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),enabled:z.boolean(),badgeWidgetId:id.nullable(),listWidgetId:id.nullable(),reviewsUrl:publicReviewsUrlInput}).strict().refine(value=>value.enabled?value.badgeWidgetId!==null&&value.listWidgetId!==null:value.badgeWidgetId===null&&value.listWidgetId===null);
export type TrustindexPublicConfiguration=z.infer<typeof configSchema>;
export function parseTrustindexPublicConfiguration(value:unknown):TrustindexPublicConfiguration|null{try{const parsed=configSchema.safeParse(value);return parsed.success?parsed.data:null;}catch{return null;}}
export function trustindexFrameUrl(value:TrustindexPublicConfiguration,generation:string){const config=configSchema.parse(value);z.string().uuid().parse(generation);if(!config.enabled)throw new Error('widget_disabled');return '/reviews/widget-frame?'+new URLSearchParams({revision:String(config.revision),badgeWidgetId:config.badgeWidgetId!,listWidgetId:config.listWidgetId!,generation});}
const messageSchema=z.object({type:z.literal('trustindex-widget'),generation:z.string().uuid(),state:z.enum(['ready','error']),height:z.number().int().min(160).max(2400)}).strict();
export function acceptTrustindexFrameMessage(event:{source:unknown;data:unknown},expectedWindow:unknown,generation:string):{state:'ready'|'error';height:number}|null{if(!expectedWindow||event.source!==expectedWindow)return null;try{const parsed=messageSchema.safeParse(event.data);return parsed.success&&parsed.data.generation===generation?{state:parsed.data.state,height:parsed.data.height}:null;}catch{return null;}}

export function chooseValidatedReviewsUrl(previous:string|null,outcome:{ok:false}|{ok:true;reviewsUrl:string|null}):string|null{return safePublicReviewsUrl(outcome.ok?outcome.reviewsUrl:previous);}
