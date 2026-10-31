import {env} from 'cloudflare:workers';
import {SITE_PROJECT_ID} from './runtime-secrets';
import {ConsoleStore} from './console-store';
import {MemoryStore} from './memory-store';
import type {GoogleAdmin} from './admin-auth-server';
export function consoleStore(admin:GoogleAdmin){if(!env.DB)throw new Error('Administration storage unavailable');return new ConsoleStore(env.DB,SITE_PROJECT_ID,admin.subject,admin.siteUserId);}
export function memoryStore(admin:GoogleAdmin){if(!env.DB)throw new Error('Memory storage unavailable');return new MemoryStore(env.DB,SITE_PROJECT_ID,admin.subject);}
