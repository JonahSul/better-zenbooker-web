import {z} from 'zod/v3';
import {bookingConfiguration,type BookingSettingsStore} from './booking-settings';
import {bookingSettingsStore} from './customer-runtime';
import {configureBooking} from './booking-admin';
export const customerSenderInput=z.object({expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),from:bookingConfiguration.shape.emailFrom.removeDefault(),zoneId:bookingConfiguration.shape.emailZoneId.removeDefault(),subdomainId:bookingConfiguration.shape.emailSubdomainId.removeDefault()}).strict();
type Dependencies={settings?:Pick<BookingSettingsStore,'read'>;configure?:typeof configureBooking};
export function customerSenderService(deps:Dependencies={}){
 const settings=()=>deps.settings??bookingSettingsStore();
 async function status(){const current=await settings().read(),check=z.enum(['verified','unavailable','failed','not_checked']).safeParse(current.senderCheck.status);return {revision:current.revision,from:current.config.emailFrom,zoneId:current.config.emailZoneId,subdomainId:current.config.emailSubdomainId,readEnabled:current.config.readEnabled,writeEnabled:current.config.writeEnabled,sendingEnabled:current.config.sendingEnabled,senderCheckStatus:check.success?check.data:'not_checked' as const,sendingTested:false as const};}
 async function configure(value:unknown,actor:string){const input=customerSenderInput.parse(value);if(!actor||actor.length>200||/[\r\n\u0000]/.test(actor))throw new Error('owner_actor_required');const current=await settings().read();if(current.revision!==input.expectedRevision)throw new Error('Settings changed');const auditId=crypto.randomUUID();await(deps.configure??configureBooking)({revision:input.expectedRevision,config:{...current.config,emailFrom:input.from,emailZoneId:input.zoneId,emailSubdomainId:input.subdomainId,writeEnabled:false,sendingEnabled:false}},{actor,auditId});return {...await status(),auditId};}
 return {status,configure};
}
