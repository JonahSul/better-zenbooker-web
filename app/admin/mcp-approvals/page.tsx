import {env} from 'cloudflare:workers';
import {getGoogleAdmin} from '../../../lib/admin-auth-server';
import {SITE_PROJECT_ID} from '../../../lib/runtime-secrets';
import {redirect} from 'next/navigation';
import ActionApprovalCard from '../../../components/action-approval-card';
export default async function Page(){const admin=await getGoogleAdmin();if(!admin)redirect('/admin');const rows=await env.DB!.prepare("SELECT id,thread_id FROM action_approvals WHERE workspace_id=? AND google_subject=? AND status='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 50").bind(SITE_PROJECT_ID,admin.subject,Date.now()).all<{id:string,thread_id:string}>();return <main className="wrap"><h1>Review proposed machine actions</h1><p>Machines cannot confirm these actions. Review each exact action and its current revision before approving.</p>{rows.results.map(row=><ActionApprovalCard key={row.id} reference={{id:row.id,threadId:row.thread_id}}/>)}</main>;}
