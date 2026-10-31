import {env,waitUntil} from 'cloudflare:workers';
import {PerformanceStore} from './performance-store';
import type {PublicTiming} from './performance-core';
export function recordPublicDocument(input:PublicTiming){if(!env.DB)return;waitUntil(new PerformanceStore(env.DB).record(input).catch(()=>{}));}
export function performanceStore(){if(!env.DB)throw new Error('Performance storage unavailable');return new PerformanceStore(env.DB);}
