import {getGoogleAdmin,type GoogleAdmin} from './admin-auth-server';
import {hostedBridgeStore,hostedBridgeReadiness,localHostedBridgeFetch} from './hosted-bridge-runtime';
import {APPROVED_BRIDGE_ORIGIN} from './hosted-bridge-store';
import {HostedBridgeService} from './hosted-bridge-service';
export function hostedBridgeService(principal?:Pick<GoogleAdmin,'subject'>|null){return new HostedBridgeService(hostedBridgeStore(),APPROVED_BRIDGE_ORIGIN,localHostedBridgeFetch,async()=>{if(!principal?.subject&&!await getGoogleAdmin())throw new Error('Verified administrator required');});}
export {hostedBridgeReadiness};
