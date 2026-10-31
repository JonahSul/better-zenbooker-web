import {redirect} from 'next/navigation';
import {requireChatGPTUser} from '../../chatgpt-auth';
import {getGoogleAdmin} from '../../../lib/admin-auth-server';
import {pageMetadata} from '../../../lib/discovery';
import AdminShell from '../../../components/admin-shell';
import BookingInquiryWorkspace from '../../../components/booking-inquiry-workspace';
export const dynamic='force-dynamic';
export const metadata=pageMetadata('/admin/inquiries','inquiries | Your business','Private Google-authorized business workspace.');
export default async function Page(){await requireChatGPTUser('/admin/inquiries');const admin=await getGoogleAdmin();if(!admin)redirect('/admin');return <AdminShell section="inquiries" email={admin.email}><BookingInquiryWorkspace/></AdminShell>;}
