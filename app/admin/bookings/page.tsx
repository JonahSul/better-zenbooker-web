import ServiceOfferingsPanel from '../../../components/service-offerings-panel';
import {redirect} from 'next/navigation';
import {requireChatGPTUser} from '../../chatgpt-auth';
import {getGoogleAdmin} from '../../../lib/admin-auth-server';
import AdminShell from '../../../components/admin-shell';
import {pageMetadata} from '../../../lib/discovery';
import HostedSetupPanel from '../../../components/hosted-setup-panel';
import ZenbookerApiPanel from '../../../components/zenbooker-api-panel';
import {BookingSettingsPanel} from '../../../components/booking-admin';
import CredentialDialog from '../../../components/credential-dialog';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/admin/bookings','Bookings | Your business','Private business workspace.');
export default async function Page(){await requireChatGPTUser('/admin/bookings');const admin=await getGoogleAdmin();if(!admin)redirect('/admin');return <AdminShell section="bookings" email={admin.email}><section className="console-card"><h2>Booking connections</h2><p>Hosted booking remains available through Zenbooker. API access and booking changes have separate controls.</p><CredentialDialog purpose="ZENBOOKER_API_KEY"/><CredentialDialog purpose="CLOUDFLARE_EMAIL_API_TOKEN"/></section><ServiceOfferingsPanel/><HostedSetupPanel/><ZenbookerApiPanel/><details><summary>Advanced booking and email controls</summary><BookingSettingsPanel/></details></AdminShell>;}
