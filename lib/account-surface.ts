import {selectActiveAccountContexts,type SignInRisk} from './account-sign-in-risk';
import type {FixedReturnContext} from './customer-google-core';
export type BookingAccountContext={active:boolean;signInRisk:()=>SignInRisk;returnContext:'book'|'support-booking';applyDetails:()=>Promise<void>;clearDetails:()=>Promise<void>;prepareSignIn:()=>boolean|Promise<boolean>};
export type SupportAccountContext={active:boolean;signInRisk:()=>SignInRisk;draft:()=>{text:string;conversation:{threadId:string;revision:number}|null};returnContext:'support-chat'|'support-booking';prepareSignIn:()=>boolean|Promise<boolean>};
class AccountSurface{
 private bookings=new Map<symbol,BookingAccountContext>();private supports=new Map<symbol,SupportAccountContext>();private listeners=new Set<()=>void>();
 private value:{booking:BookingAccountContext|null;support:SupportAccountContext|null;bookings:BookingAccountContext[];supports:SupportAccountContext[]}={booking:null,support:null,bookings:[],supports:[]};
 snapshot=()=>this.value;subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private emit(){const bookings=[...this.bookings.values()],supports=[...this.supports.values()];this.value={...selectActiveAccountContexts({bookings,supports}),bookings,supports};for(const listener of this.listeners)listener();}
 booking(context:BookingAccountContext){const key=Symbol();this.bookings.set(key,context);this.emit();return()=>{this.bookings.delete(key);this.emit();};}
 support(context:SupportAccountContext){const key=Symbol();this.supports.set(key,context);this.emit();return()=>{this.supports.delete(key);this.emit();};}
}
export const accountSurface=new AccountSurface();
export const GENERIC_ACCOUNT_SURFACE={booking:null,support:null,bookings:[],supports:[]};
const contexts:Record<string,FixedReturnContext>={'/':'home','/book':'book','/appointments':'appointments','/contact':'contact','/privacy':'privacy','/terms':'terms','/admin':'admin','/admin/chat':'admin-chat','/admin/credentials':'admin-credentials','/admin/bookings':'admin-bookings','/admin/reviews':'admin-reviews','/admin/analytics':'admin-analytics','/admin/experiments':'admin-experiments','/admin/performance':'admin-performance','/admin/analysis':'admin-analysis','/admin/support':'admin-support','/admin/memory':'admin-memory','/admin/settings':'admin-settings','/admin/audit':'admin-audit','/manage/google-reviews':'admin-reviews','/setup/credentials':'admin-credentials'};
export function accountReturnContext(pathname:string):FixedReturnContext{return contexts[pathname.replace(/\/$/,'')||'/']??'home';}
