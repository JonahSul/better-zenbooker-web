import {env} from 'cloudflare:workers';
import {SITE_PROJECT_ID} from './runtime-secrets';
import {ServiceOfferingStore} from './service-offerings';
import {buildHostedBookingUrl,type HostedHandoffInput} from './hosted-booking-core';
export async function resolveHostedOffering(value:HostedHandoffInput){const selected=value.offeringId!==undefined||value.offeringsRevision!==undefined;if(!selected)return {url:buildHostedBookingUrl(value),providerServiceId:null};if(!value.offeringId||value.offeringsRevision===undefined||value.serviceId)throw new Error('offering_changed');const offering=await new ServiceOfferingStore(env.DB!,SITE_PROJECT_ID).resolveSelection({offeringId:value.offeringId,offeringsRevision:value.offeringsRevision});const providerServiceId=offering.providerServiceId,url=new URL(buildHostedBookingUrl(value));if(providerServiceId)url.searchParams.set('preselected-service',providerServiceId);return {url:url.href,providerServiceId};}
