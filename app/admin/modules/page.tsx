import {getGoogleAdmin} from '../../../lib/admin-auth-server';
import {redirect} from 'next/navigation';
import ModuleSettings from '../../../components/module-settings';
export default async function Page(){if(!await getGoogleAdmin())redirect('/admin');return <ModuleSettings/>;}
