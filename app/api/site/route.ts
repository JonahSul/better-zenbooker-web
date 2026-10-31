import {env} from 'cloudflare:workers';
import {businessSite} from '../../../lib/business-site';
import {serviceOfferingStore} from '../../../lib/service-offerings-server';
import {moduleStatuses,type ModuleEnv} from '../../../lib/module-config';
export async function GET(){const row=await businessSite();const offerings=await serviceOfferingStore().publicOfferings();const states=await moduleStatuses(env as unknown as ModuleEnv);return Response.json({published:!!row,details:row?JSON.parse(row.details_json):null,offerings:offerings.offerings.map(o=>({offeringId:o.offeringId,name:o.name})),offeringsRevision:offerings.revision,modules:Object.fromEntries(states.map(s=>[s.module,s.status==='ready']))},{headers:{'Cache-Control':'no-store'}});}
