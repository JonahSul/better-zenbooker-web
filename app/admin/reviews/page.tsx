import TrustindexWidgetConfigurationPanel from '../../../components/trustindex-widget-configuration-panel';
import {redirect} from 'next/navigation';
import {requireChatGPTUser} from '../../chatgpt-auth';
import {getGoogleAdmin} from '../../../lib/admin-auth-server';
import AdminShell from '../../../components/admin-shell';
import {pageMetadata} from '../../../lib/discovery';
import GoogleReviewsManage from '../../../components/google-reviews-manage';
import CredentialDialog from '../../../components/credential-dialog';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/admin/reviews','Reviews | Your business','Private business workspace.');
export default async function Page(){await requireChatGPTUser('/admin/reviews');const admin=await getGoogleAdmin();if(!admin)redirect('/admin');return <AdminShell section="reviews" email={admin.email}><TrustindexWidgetConfigurationPanel/><section className="console-card"><h2>Google Business Profile</h2><p>Connect your business to review its published reviews.</p><CredentialDialog purpose="GOOGLE_BUSINESS_CLIENT_SECRET"/><GoogleReviewsManage/></section></AdminShell>;}
