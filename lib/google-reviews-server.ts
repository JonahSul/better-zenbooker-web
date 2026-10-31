import {gatedFetch} from './provider-policy';
import {resolveGoogleBusinessConfig,businessConfigFingerprint,credentialStore,SITE_PROJECT_ID} from './runtime-secrets';
import {adminGuard,getGoogleAdmin} from './admin-auth-server';

import { and, eq, gt, lte } from 'drizzle-orm';
import { getChatGPTUser } from '../app/chatgpt-auth';
import { getDb } from '../db';
import { googleConnections, googleOauthStates } from '../db/schema';
import { authorizationUrl, decryptRefreshToken, discoverLocations, encryptRefreshToken, exchangeCode, fetchReviews, googleConfig, GoogleReviewError, GOOGLE_MANAGE, hashState, refreshAccess, revokeToken } from './google-reviews-core';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}});
const cleanRedirect=(result:string)=>new Response(null,{status:303,headers:{Location:GOOGLE_MANAGE+'?connection='+result,'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}});
const safeError=(error:unknown)=>json({error:error instanceof GoogleReviewError?error.code:'temporarily_unavailable'},503);
async function discard(request:Request,collect=false){const reader=request.body?.getReader();if(!reader)return '';let size=0;const parts:Uint8Array[]=[];try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>8192){await reader.cancel();throw new Error('invalid');}if(collect)parts.push(r.value);}const bytes=new Uint8Array(size);let i=0;for(const p of parts){bytes.set(p,i);i+=p.length;}return new TextDecoder().decode(bytes);}finally{reader.releaseLock();}}
async function reject(request:Request,body:unknown,status:number){try{await discard(request);}catch{}return json(body,status);}
async function connection(userId:string){return (await getDb().select().from(googleConnections).where(eq(googleConnections.userId,userId)).limit(1))[0];}
async function access(userId:string,config:NonNullable<ReturnType<typeof googleConfig>>){const row=await connection(userId);if(!row)throw new GoogleReviewError('reauthorization_required');if(row.configFingerprint!==await businessConfigFingerprint(config)){await getDb().delete(googleConnections).where(eq(googleConnections.userId,userId));throw new GoogleReviewError('reauthorization_required');}const token=await decryptRefreshToken(row.encryptedRefreshToken,userId,config.encryptionKey);let refreshed;try{refreshed=await refreshAccess(config,token,gatedFetch('reviews'));}catch(error){if(error instanceof GoogleReviewError&&error.code==='reauthorization_required'){await getDb().delete(googleConnections).where(eq(googleConnections.userId,userId));}throw error;}if(refreshed.refresh_token){await getDb().update(googleConnections).set({encryptedRefreshToken:await encryptRefreshToken(refreshed.refresh_token,userId,config.encryptionKey),updatedAt:Date.now()}).where(and(eq(googleConnections.userId,userId),eq(googleConnections.encryptedRefreshToken,row.encryptedRefreshToken),eq(googleConnections.configFingerprint,row.configFingerprint!)));}return {row,token:refreshed.access_token};}
export async function googleReviewsRoute(action:'status'|'connect'|'locations'|'location'|'disconnect'|'display',request:Request){
 const visitor=await getChatGPTUser();const user=visitor?{...visitor,userId:SITE_PROJECT_ID}:null;if(!user)return reject(request,{error:'Sign in to use Google reviews.'},401);if(action!=='display'){const denied=await adminGuard(request);if(denied)return denied;}
 const config=await resolveGoogleBusinessConfig().catch(()=>null);
 if(action==='status'){
  if(!config)return json({configured:false,isOwner:false,connected:false,selected:false,setupUserId:user.userId,message:'Google project approval, confidential OAuth credentials, encryption key and installer-defined owner allowlist are required.'});
  if(user.userId!==config.ownerUserId)return json({error:'Only the authorized business owner can manage Google reviews.'},403);
  try{const row=await connection(config.ownerUserId);return json({configured:true,isOwner:true,connected:!!row,selected:!!row?.locationName,locationTitle:row?.locationTitle??null,message:'Google account sign-in grants business.manage permission. This application only reads accounts, locations and reviews.'});}catch{return safeError(null);}
 }
 if(!config)return reject(request,{error:'Google reviews setup is not configured.'},503);
 if(action!=='display'&&user.userId!==config.ownerUserId)return reject(request,{error:'Only the authorized business owner can access this integration.'},403);
 if(request.method==='POST'&&request.headers.get('origin')!==new URL(request.url).origin)return reject(request,{error:'Use this site to make changes.'},403);
 try{
  if(action==='connect'){
   await discard(request);const state=crypto.randomUUID()+crypto.randomUUID();const db=getDb();await db.delete(googleOauthStates).where(lte(googleOauthStates.expiresAt,Date.now()));await db.delete(googleOauthStates).where(eq(googleOauthStates.userId,user.userId));const boundary=await credentialStore().state();await db.insert(googleOauthStates).values({stateHash:await hashState(state),userId:user.userId,configFingerprint:await businessConfigFingerprint(config),configRevision:boundary.revision,expiresAt:Date.now()+600000});return json({authorizationUrl:authorizationUrl(config,state)});
  }
  if(action==='locations'){const auth=await access(user.userId,config);return json(await discoverLocations(auth.token,gatedFetch('reviews')));}
  if(action==='location'){
   let choice:unknown;try{choice=JSON.parse(await discard(request,true));}catch{return json({error:'Choose an eligible business location.'},400);}
   if(!choice||typeof choice!=='object'||!('accountName'in choice)||!('locationName'in choice)||typeof choice.accountName!=='string'||typeof choice.locationName!=='string'||!/^accounts\/[A-Za-z0-9_-]+$/.test(choice.accountName)||!/^locations\/[A-Za-z0-9_-]+$/.test(choice.locationName))return json({error:'Choose an eligible business location.'},400);
   const auth=await access(user.userId,config);const available=await discoverLocations(auth.token,gatedFetch('reviews'));const selected=available.locations.find(l=>l.accountName===choice.accountName&&l.locationName===choice.locationName);if(!selected)return json({error:'This location was not returned for the authorized Google account.'},403);
   await getDb().update(googleConnections).set({accountName:selected.accountName,locationName:selected.locationName,locationTitle:selected.title,mapsUrl:selected.mapsUrl,updatedAt:Date.now()}).where(eq(googleConnections.userId,user.userId));return json({saved:true,locationTitle:selected.title});
  }
  if(action==='disconnect'){
   await discard(request);let revoked=false;try{const row=await connection(user.userId);if(row){try{revoked=await revokeToken(await decryptRefreshToken(row.encryptedRefreshToken,user.userId,config.encryptionKey));}catch{revoked=false;}}else revoked=true;}finally{await getDb().delete(googleConnections).where(eq(googleConnections.userId,user.userId));await getDb().delete(googleOauthStates).where(eq(googleOauthStates.userId,user.userId));}return json({disconnected:true,remoteRevocationConfirmed:revoked});
  }
  const auth=await access(config.ownerUserId,config);if(!auth.row.accountName||!auth.row.locationName)return json({state:'no_location',reviews:[]});const data=await fetchReviews(auth.token,auth.row.accountName,auth.row.locationName,gatedFetch('reviews'));return json({state:'connected',locationTitle:auth.row.locationTitle,mapsUrl:auth.row.mapsUrl,...data});
 }catch(error){return safeError(error);}
}
export async function googleReviewsCallback(request:Request){
 const visitor=await getChatGPTUser();const user=visitor?{...visitor,userId:SITE_PROJECT_ID}:null;const config=await resolveGoogleBusinessConfig().catch(()=>null);if(!user||!config||user.userId!==config.ownerUserId||!await getGoogleAdmin(request))return cleanRedirect('not_authorized');
 const url=new URL(request.url);const state=url.searchParams.get('state');if(!state||state.length>256)return cleanRedirect('invalid_state');
 try{const consumed=await getDb().delete(googleOauthStates).where(and(eq(googleOauthStates.stateHash,await hashState(state)),eq(googleOauthStates.userId,user.userId),gt(googleOauthStates.expiresAt,Date.now()))).returning();if(!consumed.length)return cleanRedirect('invalid_state');const boundary=await credentialStore().state();const fingerprint=await businessConfigFingerprint(config);if(consumed[0].configFingerprint!==fingerprint||consumed[0].configRevision!==boundary.revision)return cleanRedirect('configuration_changed');if(url.searchParams.has('error'))return cleanRedirect('denied');const code=url.searchParams.get('code');if(!code||code.length>8192)return cleanRedirect('missing_code');const tokens=await exchangeCode(config,code,gatedFetch('reviews'));const old=await connection(user.userId);if(!tokens.refresh_token&&!old)return cleanRedirect('reauthorization_required');const encrypted=tokens.refresh_token?await encryptRefreshToken(tokens.refresh_token,user.userId,config.encryptionKey):old!.encryptedRefreshToken;const store=credentialStore();const saved=await store.statement('INSERT INTO google_connections(user_id,encrypted_refresh_token,config_fingerprint,updated_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM app_credential_state WHERE project_id=? AND revision=?) ON CONFLICT(user_id) DO UPDATE SET encrypted_refresh_token=excluded.encrypted_refresh_token,config_fingerprint=excluded.config_fingerprint,account_name=NULL,location_name=NULL,location_title=NULL,maps_url=NULL,updated_at=excluded.updated_at',user.userId,encrypted,fingerprint,Date.now(),SITE_PROJECT_ID,boundary.revision).run();if(!saved.meta.changes)return cleanRedirect('configuration_changed');return cleanRedirect('connected');}catch{return cleanRedirect('connection_failed');}
}







