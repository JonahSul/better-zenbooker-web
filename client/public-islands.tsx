import {startElementMeasurement} from '../lib/element-measurement-browser';
import SeasonalLandscape from '../components/seasonal-landscape';
import ConnectedAccountMenu from '../components/connected-account-menu';
import {documentFeedbackReference} from '../lib/feedback-client';
import SectionFeedback from '../components/section-feedback';
import {createRoot,hydrateRoot} from 'react-dom/client';
import InquiryForm from '../components/inquiry-form';
import Reviews from '../components/reviews';
import VisitorSupport from '../components/visitor-support';
import {AnalyticsConsent} from '../components/analytics';
import ExperimentsConsent from '../components/experiments-consent';
import '../app/globals.css';
const islands={seasonal:SeasonalLandscape,account:ConnectedAccountMenu,inquiry:InquiryForm,reviews:Reviews,analytics:AnalyticsConsent,experiments:ExperimentsConsent,support:VisitorSupport};
const optionalModules:Record<string,string>={account:'google',reviews:'reviews',analytics:'analytics',experiments:'experiments',support:'visitor_support'};
const capabilities=fetch('/api/site',{cache:'no-store'}).then(response=>response.ok?response.json():null).then(value=>(value as {modules?:Record<string,boolean>}|null)?.modules??{}).catch(()=>({} as Record<string,boolean>));
for(const [name,Component]of Object.entries(islands)){for(const node of document.querySelectorAll('[data-public-island="'+name+'"]')){const mount=()=>{if(!node.isConnected)return;if(name==='seasonal')hydrateRoot(node,<Component/>);else createRoot(node).render(<Component/>);};const module=optionalModules[name];if(module)void capabilities.then(ready=>{if(ready[module]===true&&(name!=='support'||ready.ai===true))mount();});else mount();}}

if(documentFeedbackReference())for(const mount of document.querySelectorAll<HTMLElement>('[data-feedback-section]')){const section=mount.dataset.feedbackSection;if(section)createRoot(mount).render(<SectionFeedback section={section}/>);}


startElementMeasurement();
