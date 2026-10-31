import {redirect} from 'next/navigation';
import {requireChatGPTUser} from '../../chatgpt-auth';
import {getGoogleAdmin} from '../../../lib/admin-auth-server';
import {pageMetadata} from '../../../lib/discovery';
import AdminShell from '../../../components/admin-shell';
import ExperimentsAdmin from '../../../components/experiments-admin';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/admin/experiments','experiments | Your business','Private Google-authorized business workspace.');
export default async function Page(){await requireChatGPTUser('/admin/experiments');const admin=await getGoogleAdmin();if(!admin)redirect('/admin');return <AdminShell section="experiments" email={admin.email}><ExperimentsAdmin/></AdminShell>;}
