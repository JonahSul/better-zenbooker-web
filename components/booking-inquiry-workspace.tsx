'use client';
import ContactInbox from './contact-inbox';
import ContactNotificationsPanel from './contact-notifications-panel';
import {useState} from 'react';
import {CalendarDays,Inbox} from 'lucide-react';
import InquiriesAdmin from './inquiries-admin';
import {AppointmentsAdmin} from './booking-admin';
export default function BookingInquiryWorkspace(){const [view,setView]=useState<'contact'|'appointments'|'legacy'>('contact');return <><div className="console-actions" role="group" aria-label="Record type"><button aria-pressed={view==='contact'} onClick={()=>setView('contact')}><Inbox aria-hidden="true" size={18}/>Contact messages</button><button aria-pressed={view==='appointments'} onClick={()=>setView('appointments')}><CalendarDays aria-hidden="true" size={18}/>Website appointments</button><button aria-pressed={view==='legacy'} onClick={()=>setView('legacy')}><Inbox aria-hidden="true" size={18}/>Legacy date requests</button></div>{view==='contact'?<><ContactInbox/><ContactNotificationsPanel/></>:view==='appointments'?<AppointmentsAdmin/>:<InquiriesAdmin/>}</>;}
