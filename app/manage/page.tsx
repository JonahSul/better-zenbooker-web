import {getGoogleAdmin} from '../../lib/admin-auth-server';
import {redirect} from 'next/navigation';
import {requireChatGPTUser} from '../chatgpt-auth';
export const dynamic='force-dynamic';
export default async function Page(){await requireChatGPTUser('/manage');if(!await getGoogleAdmin())redirect('/admin');redirect('/admin/inquiries');}
