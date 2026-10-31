import {headers} from 'next/headers';
import {redirect} from 'next/navigation';
import {cookieValue,sha256} from '../lib/admin-auth-core';
export type ChatGPTUser={userId:string;displayName:string;email:string;fullName:string|null};
// First-party visitor namespace. Owner privilege always requires a verified allowlisted Google session.
export async function getChatGPTUser():Promise<ChatGPTUser|null>{const h=await headers();const token=cookieValue(new Request('https://session.invalid',{headers:h}),'__Host-browser_session');if(!token||! /^[0-9a-f]{64}$/.test(token))return null;return {userId:'browser:'+await sha256(token),displayName:'Visitor',email:'',fullName:null};}
export async function requireChatGPTUser(returnTo:string){const user=await getChatGPTUser();if(user)return user;redirect(chatGPTSignInPath(returnTo));}
function safeReturn(value:string){try{if(/[\\\x00-\x1f]/.test(value)||!value.startsWith('/'))return '/';const u=new URL(value,'https://session.invalid');return u.origin==='https://session.invalid'?u.pathname+u.search+u.hash:'/';}catch{return '/';}}
export function chatGPTSignInPath(returnTo:string){return '/session/start?return_to='+encodeURIComponent(safeReturn(returnTo));}
export function chatGPTSignOutPath(returnTo='/'){return '/session/end?return_to='+encodeURIComponent(safeReturn(returnTo));}
