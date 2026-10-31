import {env} from 'cloudflare:workers';
import {SupportPhotoStore,type PhotoBucket} from './support-photo-store';
import {SITE_PROJECT_ID} from './runtime-secrets';
export function supportPhotoStore(){const bucket=(env as unknown as {BUCKET?:R2Bucket}).BUCKET;if(!env.DB||!bucket)throw new Error('Private photo storage unavailable');return new SupportPhotoStore(env.DB,bucket as unknown as PhotoBucket,SITE_PROJECT_ID);}
export function photoStorageAvailable(){return !!(env as unknown as {BUCKET?:R2Bucket}).BUCKET;}
