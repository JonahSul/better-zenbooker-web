'use client';
import {useEffect,useState} from 'react';
import {usePathname} from 'next/navigation';
export default function SensitiveRouteBoundary({children}:{children:React.ReactNode}){const pathname=usePathname();const sensitive=!!pathname&&['/admin','/setup','/manage','/book','/appointments'].some(prefix=>pathname.startsWith(prefix));const [checkedPath,setCheckedPath]=useState('');useEffect(()=>{let active=true;if(sensitive){if(document.getElementById('optional-gtm')){window.location.reload();return;}Promise.resolve().then(()=>{if(active)setCheckedPath(pathname??'');});}return()=>{active=false;};},[pathname,sensitive]);if(sensitive&&checkedPath!==pathname)return <main className="wrap simple-page"><p role="status">Opening private workspace…</p></main>;return children;}
