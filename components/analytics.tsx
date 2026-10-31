'use client';
import {choosePurposeConsent,refreshPurposeConsent,subscribePurposeConsent,consentSnapshot,pendingPurposeDenial} from '../lib/consent-client';
import {bindGoogleTagIdentity} from '../lib/tag-identity-client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { analyticsContext, publicAnalyticsPath, eventPayload, validContainerId,createPageViewTracker } from '../lib/analytics-contract';
type EventName='service_select'|'contact_click'|'generate_lead';
type Placement='hero'|'navigation'|'services'|'form'|'footer';
declare global {interface Window {dataLayer?:unknown[];}}
let enabled=false,loadedContainerIdentity:string|null=null,reloadRequested=false;
let adminSessionPresent=false;
const documentPageView=createPageViewTracker();
let consentChoice="";
const consentListeners=new Set<()=>void>();
function subscribeConsent(listener:()=>void){consentListeners.add(listener);return ()=>{consentListeners.delete(listener);};}
function publishConsent(choice:string){consentChoice=choice;for(const listener of consentListeners)listener();}
type ConsentStatus={analytics:boolean;experiments?:boolean;measurementId?:string|null;analyticsSaved?:boolean;analyticsSuppressed?:boolean;containerId?:string|null;configRevision?:number|null};
function maybeBind(status:ConsentStatus){if(status.analytics&&status.experiments&&!status.analyticsSuppressed)bindGoogleTagIdentity(status.measurementId,()=>enabled&&!!publicAnalyticsPath(location.pathname));}
function context(){return analyticsContext(location.pathname);}
export function track(name:EventName,service:string,placement:Placement){const payload=eventPayload(enabled,name,service,placement,location.pathname);if(payload)window.dataLayer?.push(payload);}
export function TrackedPhone({placement='navigation'}:{placement?:Placement}){return <a href="tel:" onClick={()=>track('contact_click','general',placement)}>Configured contact number ↗</a>;}
export function AnalyticsConsent(){const choice=useSyncExternalStore(subscribeConsent,()=>consentChoice,()=> '');const [message,setMessage]=useState('');const [pending,setPending]=useState(false);const [withdrawalPending,setWithdrawalPending]=useState(false);useEffect(()=>{let active=true;function update(){if(!active)return;const result=consentSnapshot();const recovering=pendingPurposeDenial('analytics');setWithdrawalPending(recovering);if(!recovering&&!result.analytics)setMessage(current=>current.startsWith('Choice not saved.')?'':current);adminSessionPresent=!!result.analyticsSuppressed;if(!result.analytics){applyConsent(false,false);}if(result.analyticsSuppressed){enabled=false;publishConsent(result.analyticsSaved?'allowed':'');setMessage('Paused while an admin session is present.');}else if(result.analytics){applyConsent(true);maybeBind(result);}}const unsubscribe=subscribePurposeConsent(update);void refreshPurposeConsent().then(update).catch(()=>{});return()=>{active=false;unsubscribe();};},[]);
 function applyConsent(allow:boolean,reload=true){const result=consentSnapshot(),containerId=result?.containerId,configRevision=result?.configRevision,valid=typeof containerId==='string'&&validContainerId(containerId)&&Number.isSafeInteger(configRevision),identity=JSON.stringify([valid,containerId??null,configRevision??null]);if(reloadRequested){enabled=false;return;}if(allow&&!publicAnalyticsPath(window.location.pathname)){enabled=false;return;}enabled=allow&&valid;publishConsent(allow?'allowed':'declined');window.dataLayer=window.dataLayer||[];function command(...args:unknown[]){
// GTM's documented command queue uses an Arguments object, rather than an event array.
void args;
// eslint-disable-next-line prefer-rest-params
window.dataLayer!.push(arguments);
}if(allow&&document.getElementById('optional-gtm')&&loadedContainerIdentity!==identity){enabled=false;command('consent','update',{analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});reloadRequested=true;window.location.reload();return;}if(!allow||!valid){enabled=false;command('consent','update',{analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});if(reload&&!allow&&document.getElementById('optional-gtm'))window.location.reload();return;}command('consent','default',{analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});command('consent','update',{analytics_storage:'granted',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});command('set',{...context(),send_page_view:false});if(!document.getElementById('optional-gtm')){window.dataLayer.push({'gtm.start':Date.now(),event:'gtm.js',...context()});const script=document.createElement('script');script.id='optional-gtm';script.async=true;script.src='https://www.googletagmanager.com/gtm.js?id='+containerId;loadedContainerIdentity=identity;document.head.appendChild(script);}const pageView=documentPageView.take(allow,adminSessionPresent,location.pathname);if(pageView)window.dataLayer.push(pageView);}
 async function consent(allow:boolean){if(pending)return;if(!allow)enabled=false;setPending(true);setMessage('');try{const result=await choosePurposeConsent('analytics',allow);adminSessionPresent=!!result.analyticsSuppressed;if(allow&&result.analyticsSuppressed){enabled=false;publishConsent('allowed');setMessage('Choice saved. Analytics paused while an admin session is present.');}else{applyConsent(result.analytics);if(result.analytics)maybeBind(result);}}catch(error){setMessage(error instanceof Error&&error.message.startsWith('Allow unavailable:')?error.message:'Choice not saved. Optional activity remains off; refresh and choose again.');}finally{setPending(false);}}
 return <details className="analytics-control"><summary>Analytics</summary><div className="analytics-actions">{choice!=='allowed'?<><button type="button" disabled={pending} aria-label="Allow analytics" onClick={()=>consent(true)}>Allow</button><button type="button" disabled={pending} aria-label="Decline analytics" onClick={()=>consent(false)}>Decline</button></>:<button type="button" disabled={pending} onClick={()=>consent(false)}>Withdraw consent</button>}<a href="/privacy">Privacy</a><span role="status" aria-live="polite">{withdrawalPending?'Withdrawal pending · not saved yet. Optional activity is off in this browser.':message||(choice==='allowed'?(enabled?'Analytics on':'Choice saved · browser container unavailable'):choice==='declined'?'Analytics off':'Optional · off until allowed')}</span></div></details>;
}




export function AnalyticsRouteFooter(){const pathname=usePathname();if(!pathname||pathname==='/'||pathname.startsWith('/book')||pathname.startsWith('/appointments'))return null;if(pathname?.startsWith('/admin')||pathname?.startsWith('/manage')||pathname?.startsWith('/setup')||pathname?.startsWith('/book')||pathname?.startsWith('/appointments'))return <footer className="route-footer"><div className="wrap"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></div></footer>;return <footer className="route-footer"><div className="wrap"><AnalyticsConsent/></div></footer>;}





