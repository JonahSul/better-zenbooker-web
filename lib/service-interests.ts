import {serviceOfferingStore} from './service-offerings-server';
export async function validateServiceInterests(ids:string[]){const published=await serviceOfferingStore().publicOfferings();if(ids.some(id=>!published.offerings.some(o=>o.offeringId===id)))throw new Error('Service offerings changed');return published.offerings;}
