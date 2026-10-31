'use client';
/* eslint-disable @next/next/no-img-element, @next/next/no-html-link-for-pages -- Existing self-hosted brand and full document navigation. */
import {useEffect,useState} from 'react';
import {adminOutcomeMessage} from '../lib/admin-outcome';
import {AdminAccountMenu} from './admin-account-menu';
export default function AdminLogin(){
 const [configured,setConfigured]=useState(false),[message,setMessage]=useState('Checking sign-in…'),[busy,setBusy]=useState(false);
 useEffect(()=>{let active=true;fetch('/api/admin/auth/status',{cache:'no-store'}).then(async response=>await response.json() as {configured:boolean;authenticated:boolean}).then(data=>{if(active){setConfigured(data.configured);setMessage(adminOutcomeMessage(new URLSearchParams(window.location.search).get('auth'),data.authenticated)??(data.configured?'Use the account menu to sign in securely.':'Sign-in is temporarily unavailable. Please try again later.'));}}).catch(()=>{if(active)setMessage('Sign-in is unavailable. Please try again.');});return()=>{active=false;};},[]);
 async function connect(){setBusy(true);try{const response=await fetch('/api/admin/auth/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const result=await response.json() as {authorizationUrl?:string};if(!response.ok||!result.authorizationUrl)throw new Error();window.location.assign(result.authorizationUrl);}catch{setMessage('Sign-in could not be started. Please try again.');setBusy(false);}}
 return <section className="admin-entry"><header><a href="/" aria-label="Your business website"><span>Business</span></a><AdminAccountMenu onSignIn={()=>void connect()} signInDisabled={!configured||busy}/></header><div className="admin-entry-copy"><p className="console-kicker">YOUR BUSINESS WORKSPACE</p><h1>Good care.<br/>A clearer view.</h1><p>Keep an eye on requests, helpful answers and the work ahead.</p><p className="admin-entry-status" role="status">{busy?'Opening secure sign-in…':message}</p></div><footer><span>Your business workspace.</span><div><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div></footer></section>;
}
