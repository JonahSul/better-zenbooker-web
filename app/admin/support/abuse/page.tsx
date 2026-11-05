import {redirect} from 'next/navigation';
import {getGoogleAdmin} from '../../../../lib/admin-auth-server';
import {secretRuntime} from '../../../../lib/runtime-secrets';
import AdminShell from '../../../../components/admin-shell';
import VisitorAbuseReview from '../../../../components/visitor-abuse-review';
export const dynamic='force-dynamic';
export const metadata={title:'Visitor abuse review',robots:{index:false,follow:false}};
export default async function Page(){const admin=await getGoogleAdmin();if(!admin)redirect('/admin');return <AdminShell section="support" email={admin.email}><VisitorAbuseReview/></AdminShell>;}
