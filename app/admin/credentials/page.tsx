import {credentialPageAccess} from '../../../lib/credential-server';
import CredentialSetup from '../../../components/credential-setup';
import AdminShell from '../../../components/admin-shell';
import {pageMetadata} from '../../../lib/discovery';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/admin/credentials','Credentials | Your business','Private integration credentials.');
export default async function Page(){const access=await credentialPageAccess();if(!access.allowed)return <main className="wrap simple-page"><h1>Credentials</h1><p>Sign in as the workspace owner to manage keys.</p><a href="/admin">Sign in with Google</a></main>;return <AdminShell section="credentials" email={access.admin?.email}><CredentialSetup/></AdminShell>;}
