import {redirect} from 'next/navigation';
import {requireChatGPTUser} from '../../chatgpt-auth';
import {getGoogleAdmin} from '../../../lib/admin-auth-server';
import {pageMetadata} from '../../../lib/discovery';
import AdminShell from '../../../components/admin-shell';
import {PerformancePanel} from '../../../components/console-panels';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/admin/performance','performance | Your business','Private Google-authorized business workspace.');
export default async function Page(){await requireChatGPTUser('/admin/performance');const admin=await getGoogleAdmin();if(!admin)redirect('/admin');return <AdminShell section="performance" email={admin.email}><PerformancePanel/></AdminShell>;}
