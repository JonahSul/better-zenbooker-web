import {env} from 'cloudflare:workers';
import {businessSite} from '../lib/business-site';
import {serviceOfferingStore} from '../lib/service-offerings-server';
import {moduleStatuses,type ModuleEnv} from '../lib/module-config';
import InquiryForm from '../components/inquiry-form';
import Reviews from '../components/reviews';
import ConnectedAccountMenu from '../components/connected-account-menu';
import {AnalyticsConsent} from '../components/analytics';
import ExperimentsConsent from '../components/experiments-consent';
export const dynamic='force-dynamic';
export default async function Home(){const row=await businessSite();if(!row)return <main className="wrap"><h1>Business setup required</h1><p>The owner has not published business details.</p><p>Business owners can open the administration URL supplied with this installation.</p></main>;const d=JSON.parse(row.details_json);const states=await moduleStatuses(env as unknown as ModuleEnv);const ready=(name:string)=>states.some(s=>s.module===name&&s.status==='ready');let offerings:any[]=[];try{offerings=(await serviceOfferingStore().publicOfferings()).offerings;}catch{}return <main className="wrap" data-theme={d.theme} style={d.theme==='dark'?{background:'#18332e',color:'#f3faf6'}:{}}><nav>{ready('booking')&&<><a data-measurement-element="home_book_header" href="/book">Book</a> · <a href="/appointments">Appointments</a> · </>}<a data-measurement-element="home_contact_header" href="/contact">Contact</a>{ready('google')&&<ConnectedAccountMenu/>}</nav><h1 data-measurement-element="home_heading">{d.name}</h1><p>{d.description}</p><p>{d.area}</p><p>{d.phone} {d.email}</p><section><h2 data-measurement-element="home_services_heading">Services</h2>{offerings.map((o,index)=><article data-measurement-element={index<4?`home_service_${index+1}`:undefined} key={o.offeringId}><h3>{o.name}</h3>{ready('booking')&&<a href="/book">Check availability</a>}</article>)}</section>{ready('reviews')&&<Reviews/>}<section><h2 data-measurement-element="home_request_heading">Request a preferred date</h2><InquiryForm/></section>{ready('analytics')&&<AnalyticsConsent/>}{ready('experiments')&&<ExperimentsConsent/>}</main>;}
