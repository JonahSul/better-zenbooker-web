'use client';
import {useEffect,useRef,useState} from 'react';
import {Menu} from 'lucide-react';
import {Dialog,DialogTrigger,DialogContent,DialogHeader,DialogTitle,DialogDescription} from './ui/dialog';
import {AdminNavigation} from './admin-navigation';
import './mobile-admin-navigation.css';
export default function MobileAdminNavigation({section}:{section:string}){
 const [open,setOpen]=useState(false),desktop=useRef(false);
 useEffect(()=>{const media=window.matchMedia('(min-width: 681px)');desktop.current=media.matches;const resize=()=>{desktop.current=media.matches;if(media.matches)setOpen(false);};media.addEventListener('change',resize);return()=>media.removeEventListener('change',resize);},[]);
 return <Dialog open={open} onOpenChange={value=>{if(!value||!desktop.current)setOpen(value);}}><DialogTrigger asChild><button type="button" className="console-mobile-menu"><Menu size={18} aria-hidden="true" focusable="false"/>Menu</button></DialogTrigger><DialogContent className="console-mobile-drawer" onCloseAutoFocus={event=>{if(!desktop.current)return;event.preventDefault();const active=document.querySelector<HTMLElement>('.console-desktop-navigation [aria-current="page"]');if(active?.isConnected&&active.getClientRects().length)active.focus();else document.getElementById('console-main')?.focus();}}><DialogHeader className="console-mobile-drawer-heading"><DialogTitle>Administration</DialogTitle><DialogDescription>Choose a workspace page.</DialogDescription></DialogHeader><AdminNavigation section={section} onNavigate={()=>setOpen(false)}/></DialogContent></Dialog>;
}
