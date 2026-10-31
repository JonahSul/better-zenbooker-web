import {redirect} from 'next/navigation';
import {requireChatGPTUser} from '../../chatgpt-auth';
import {getGoogleAdmin} from '../../../lib/admin-auth-server';
import {pageMetadata} from '../../../lib/discovery';
import AdminShell from '../../../components/admin-shell';
import {SettingsPanel} from '../../../components/console-panels';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/admin/settings','settings | Your business','Private Google-authorized business workspace.');
export default async function Page(){await requireChatGPTUser('/admin/settings');const admin=await getGoogleAdmin();if(!admin)redirect('/admin');return <AdminShell section="settings" email={admin.email}><p><a href="/admin/bookings">Bookings and connections</a> · <a href="/admin/analytics">Analytics</a> · <a href="/admin/credentials">Credentials</a></p><SettingsPanel/></AdminShell>;}
