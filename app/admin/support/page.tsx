import {redirect} from 'next/navigation';
import {requireChatGPTUser} from '../../chatgpt-auth';
import {getGoogleAdmin} from '../../../lib/admin-auth-server';
import {pageMetadata} from '../../../lib/discovery';
import AdminShell from '../../../components/admin-shell';
import SupportAdmin from '../../../components/support-admin';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/admin/support','Visitor support knowledge | Your business','Private approved public knowledge, visitor support budgets, feedback and curation review.');
export default async function Page(){await requireChatGPTUser('/admin/support');const admin=await getGoogleAdmin();if(!admin)redirect('/admin');return <AdminShell section="support" email={admin.email}><SupportAdmin/></AdminShell>;}
