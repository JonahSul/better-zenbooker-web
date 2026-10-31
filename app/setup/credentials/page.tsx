import {redirect} from 'next/navigation';
import {credentialDestination} from '../../../lib/credential-server';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){redirect(credentialDestination((await searchParams).purpose));}
