import {CustomerGoogleStore} from './customer-google-store';
import {env} from 'cloudflare:workers';
import {SupportStore} from './support-store';
import {SupportPhotoStore,type PhotoBucket} from './support-photo-store';
import {SupportProxy} from './support-proxy';
import type {ModuleEnv} from './module-config';
export function supportStore(runtime:ModuleEnv=env as unknown as ModuleEnv){if(!runtime.DB||!runtime.INSTALLATION_ID)throw new Error('Support storage unavailable');const store=new SupportStore(runtime.DB,runtime.INSTALLATION_ID,typeof runtime.APP_CREDENTIAL_ENCRYPTION_KEY==='string'?runtime.APP_CREDENTIAL_ENCRYPTION_KEY:undefined);store.photoMaintenance=async()=>{await new CustomerGoogleStore(runtime.DB!,runtime.INSTALLATION_ID!).cleanup();if(runtime.BUCKET)await new SupportPhotoStore(runtime.DB!,runtime.BUCKET as PhotoBucket,runtime.INSTALLATION_ID!).cleanup();};return store;}
export function supportProxy(runtime:ModuleEnv=env as unknown as ModuleEnv){return new SupportProxy(supportStore(runtime),'https://internal.invalid',fetch,()=>!!runtime.BUCKET,runtime);}
