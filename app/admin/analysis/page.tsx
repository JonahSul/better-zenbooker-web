import CredentialDialog from '../../../components/credential-dialog';
import {redirect} from 'next/navigation';
import {requireChatGPTUser} from '../../chatgpt-auth';
import {getGoogleAdmin} from '../../../lib/admin-auth-server';
import {pageMetadata} from '../../../lib/discovery';
import AdminShell from '../../../components/admin-shell';
import AnalysisAdmin from '../../../components/analysis-admin';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/admin/analysis','analysis | Your business','Private Google-authorized business workspace.');
export default async function Page(){await requireChatGPTUser('/admin/analysis');const admin=await getGoogleAdmin();if(!admin)redirect('/admin');return <AdminShell section="analysis" email={admin.email}><section className="console-card"><h2>Analysis service key</h2><p>This key serves workspace analysis. Visitor assistance uses a separate connection.</p><CredentialDialog purpose="WORKERS_AI_API_TOKEN"/></section><AnalysisAdmin/></AdminShell>;}
