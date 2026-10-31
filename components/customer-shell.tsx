import ConnectedAccountMenu from './connected-account-menu';
/* eslint-disable @next/next/no-img-element, @next/next/no-html-link-for-pages -- Actual self-hosted branding and full document navigation protect transactional pages. */
import './customer.css';
import {ArrowUpRight} from 'lucide-react';
export default function CustomerShell({title,eyebrow,children,measurementId}:{title:string;eyebrow:string;children:React.ReactNode;measurementId?:'book_heading'|'appointments_heading'|'contact_heading'}){return <div className="customer-page"><header className="customer-header"><a href="/" aria-label="Your business home"><span>Business</span></a><nav aria-label="Customer navigation"><a href="/book">Book a service</a><a href="/appointments">Appointment help</a><a href="/contact">Contact</a></nav><ConnectedAccountMenu/></header><main className="customer-main"><p className="customer-eyebrow">{eyebrow}</p><h1 data-measurement-element={measurementId}>{title}</h1>{children}</main><footer className="customer-footer"><p>Your business workspace.</p><div><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div></footer></div>;}

