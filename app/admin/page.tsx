import NativeAdminRecovery from '../../components/native-admin-recovery';
import {getChatGPTUser} from '../chatgpt-auth';
import {getGoogleAdmin} from '../../lib/admin-auth-server';
import {pageMetadata} from '../../lib/discovery';
import AdminLogin from '../../components/admin-login';
import AdminShell from '../../components/admin-shell';
import {Overview} from '../../components/console-panels';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/admin','Administration | Your business','Private Google-authorized business administration.');
export default async function Page(){if(!await getChatGPTUser())return <NativeAdminRecovery/>;const admin=await getGoogleAdmin();return admin?<AdminShell section="" email={admin.email}><Overview/></AdminShell>:<main className="admin-entry-page"><AdminLogin/></main>;}
