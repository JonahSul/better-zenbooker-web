import CredentialDialog from '../../../components/credential-dialog';
import {redirect} from 'next/navigation';
import {requireChatGPTUser} from '../../chatgpt-auth';
import {getGoogleAdmin} from '../../../lib/admin-auth-server';
import {pageMetadata} from '../../../lib/discovery';
import AdminShell from '../../../components/admin-shell';
import MemoryAdmin from '../../../components/memory-admin';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/admin/memory','memory | Your business','Private Google-authorized business workspace.');
export default async function Page(){await requireChatGPTUser('/admin/memory');const admin=await getGoogleAdmin();if(!admin)redirect('/admin');return <AdminShell section="memory" email={admin.email}><section className="console-card"><h2>Knowledge search</h2><CredentialDialog purpose="VECTORIZE_API_TOKEN"/></section><MemoryAdmin/></AdminShell>;}
