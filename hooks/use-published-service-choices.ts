'use client';
import {useEffect,useState} from 'react';
export function usePublishedServiceChoices(){const [choices,setChoices]=useState<[string,string][]>([]);useEffect(()=>{const controller=new AbortController();fetch('/api/site',{signal:controller.signal}).then(r=>r.json()).then((v:any)=>setChoices((v.offerings??[]).map((o:any)=>[o.offeringId,o.name]))).catch(()=>{});return()=>controller.abort();},[]);return choices;}
