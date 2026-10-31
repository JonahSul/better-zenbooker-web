import {validMeasurementId,validTagClientId} from './tag-identity-core';
let requested=false,generation=0;
export function resetGoogleTagIdentityBinding(){requested=false;generation++;}
export function bindGoogleTagIdentity(measurementId:unknown,allowed:()=>boolean){if(requested||!validMeasurementId(measurementId)||!allowed()||!document.getElementById('optional-gtm'))return;requested=true;const expectedGeneration=generation;let finished=false;const timer=window.setTimeout(()=>{finished=true;},2500);function receive(value:unknown){if(finished||expectedGeneration!==generation)return;finished=true;clearTimeout(timer);if(!allowed()||!validTagClientId(value))return;void fetch('/api/analytics/tag-identity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:value}),signal:AbortSignal.timeout(3000)}).catch(()=>{});}
 window.dataLayer=window.dataLayer||[];
 function command(...args:unknown[]){void args;
 // Google's documented command queue consumes Arguments objects.
 // eslint-disable-next-line prefer-rest-params
 window.dataLayer!.push(arguments);
 }
 command('get',measurementId,'client_id',receive);
}
