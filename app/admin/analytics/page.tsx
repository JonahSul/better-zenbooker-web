import ElementActivityPanel from '../../../components/element-activity-panel';
import {redirect} from 'next/navigation';
import {requireChatGPTUser} from '../../chatgpt-auth';
import {getGoogleAdmin} from '../../../lib/admin-auth-server';
import AdminShell from '../../../components/admin-shell';
import {pageMetadata} from '../../../lib/discovery';
import AnalyticsConfigurationPanel from '../../../components/analytics-configuration-panel';
import CredentialDialog from '../../../components/credential-dialog';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/admin/analytics','Analytics | Your business','Private business workspace.');
export default async function Page(){await requireChatGPTUser('/admin/analytics');const admin=await getGoogleAdmin();if(!admin)redirect('/admin');return <AdminShell section="analytics" email={admin.email}><AnalyticsConfigurationPanel/><ElementActivityPanel/><section className="console-card"><h2>Google Analytics measurement</h2><p>Measurement Protocol and the browser container use separate settings.</p><CredentialDialog purpose="GA4_MP_API_SECRET"/><p><a href="/admin/analysis">Reporting, providers and analysis</a></p></section></AdminShell>;}
