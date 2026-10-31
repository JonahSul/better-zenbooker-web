export class HttpError extends Error{constructor(public status:number,public code:string){super(code);}}
export const fail=(status:number,code:string):never=>{throw new HttpError(status,code);};
export const escape=(x:unknown)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export async function bounded(r:{body:ReadableStream<Uint8Array>|null},max=262144){const reader=r.body?.getReader();if(!reader)return '';let text='',n=0;const decoder=new TextDecoder();try{for(;;){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>max){await reader.cancel();fail(413,'body_too_large');}text+=decoder.decode(value,{stream:true});}return text+decoder.decode();}finally{reader.releaseLock();}}
export function publicUrl(value:string){let u:URL;try{u=new URL(value);}catch{return fail(400,'invalid_source_url');}const h=u.hostname.toLowerCase();if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||h.includes(':')||/^\d+(?:\.\d+)*$/.test(h)||!h.includes('.')||/\.(localhost|local|internal|test|invalid|example)$/.test(h)||['localhost','metadata.google.internal'].includes(h))fail(400,'unsafe_source_url');return u;}



