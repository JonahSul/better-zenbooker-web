'use client';
import {usePathname} from 'next/navigation';
import {useEffect,useState} from 'react';
import VisitorSupport from './visitor-support';
export default function PublicSupportBoundary(){const pathname=usePathname();const [ready,setReady]=useState(false);useEffect(()=>{const controller=new AbortController();fetch('/api/site',{signal:controller.signal}).then(r=>r.json()).then((v:any)=>setReady(v.modules?.visitor_support===true)).catch(()=>{});return()=>controller.abort();},[]);if(!ready||!pathname||['/admin','/manage','/setup'].some(prefix=>pathname.startsWith(prefix)))return null;return <VisitorSupport/>;}
