import {redirect} from 'next/navigation';
import {requireChatGPTUser} from '../../chatgpt-auth';
import {getGoogleAdmin} from '../../../lib/admin-auth-server';
import {pageMetadata} from '../../../lib/discovery';
import AdminShell from '../../../components/admin-shell';
import ChatAdmin from '../../../components/chat-admin';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/admin/chat','chat | Your business','Private Google-authorized business workspace.');
export default async function Page(){await requireChatGPTUser('/admin/chat');const admin=await getGoogleAdmin();if(!admin)redirect('/admin');return <AdminShell section="chat" email={admin.email}><ChatAdmin/></AdminShell>;}
