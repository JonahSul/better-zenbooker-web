import { DEMO_ORIGIN } from './site-config';
export function validContainerId(id:string){return /^GTM-[A-Z0-9]{6,12}$/.test(id);}
export const publicAnalyticsPaths=['/','/privacy','/terms'] as const;
export function publicAnalyticsPath(path:string){const clean=path.split(/[?#]/)[0];return publicAnalyticsPaths.some(value=>value===clean)?clean:null;}
export function analyticsContext(path:string){return {page_location:DEMO_ORIGIN+(publicAnalyticsPath(path)??'/'),page_referrer:''};}
export function eventPayload(consented:boolean,name:string,service:string,placement:string,path:string){if(!consented||!publicAnalyticsPath(path)||!['service_select','contact_click','generate_lead'].includes(name)||!(service==='general'||/^[0-9a-f-]{36}$/i.test(service))||!['hero','navigation','services','form','footer'].includes(placement))return null;return {event:name,service,placement,...analyticsContext(path)};}

export function createPageViewTracker(){let sent=false;return {take(granted:boolean,adminSessionPresent:boolean,path:string){if(sent||!granted||adminSessionPresent||!publicAnalyticsPath(path))return null;sent=true;return {event:'page_view',...analyticsContext(path)};}};}

