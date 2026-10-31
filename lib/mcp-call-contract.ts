import {elementReportInput} from './element-measurement-core';
import {ga4PropertyConfigurationInput} from './ga4-property-configuration';
import {customerSenderInput} from './customer-sender';
import {contactNotificationConfigurationInput} from './contact-notification-configuration';
import {trustindexWidgetInput} from './trustindex-widget-configuration';
import {offeringDraftInput,offeringPublishInput,offeringWithdrawInput} from './service-offerings';
import {analyticsConfigurationInput} from './analytics-configuration';
import {captureInspectInput} from '../integrations/zenbooker-bridge/capture-inspection';
import {apiCheckInputSchema,apiRefreshInputSchema} from './zenbooker-api-core';
import {scheduleObservationInput} from './support-schedule';
import {snapshotV2Input} from './snapshot-v2';
import {z} from 'zod/v3';
import {snapshotInput} from './analysis-core';
export const siteToolNames=['measurement_element_status','measurement_element_report','analytics_property_configuration_status','analytics_property_configuration_save','customer_sender_status','customer_sender_configure','contact_notification_status','contact_notification_configure','contact_notification_check_sender','contact_notification_dispatch','trustindex_widget_configuration_status','trustindex_widget_configuration_save','offerings_status','offerings_save_draft','offerings_publish','offerings_withdraw','analytics_configuration_status','analytics_configuration_save','zenbooker_api_status','zenbooker_api_check','zenbooker_api_refresh','hosted_bridge_capture_inspect','visitor_assistant_photo_configure','visitor_assistant_photo_check','visitor_assistant_record_schedule','visitor_assistant_initialize','visitor_assistant_status','visitor_assistant_check','visitor_assistant_curate','hosted_bridge_probe','hosted_bridge_initialize','experiment_connection_status','experiment_baseline_setup','experiment_baseline_status','experiment_cache_probe','experiment_batch_dry_run','experiment_batch_run','experiment_batch_status','analytics_ingest_snapshot'] as const;
const metadata=z.record(z.unknown()).optional();
const empty=z.object({}).strict().default({});
const batchArguments=z.object({versionId:z.string().uuid(),window:z.object({from:z.number().int().min(0),to:z.number().int().positive(),asOf:z.number().int().positive().optional()}).strict().refine(window=>window.to>window.from&&window.to-window.from<=366*86400000),idempotencyKey:z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/)}).strict();
// Transport metadata is never identity, permissions, provider flags or tool data.
export const siteToolCall=z.discriminatedUnion('name',[
 z.object({name:z.literal('customer_sender_status'),arguments:empty,_meta:metadata}).strict(),
 z.object({name:z.literal('customer_sender_configure'),arguments:customerSenderInput,_meta:metadata}).strict(),
 z.object({name:z.literal('offerings_status'),arguments:empty,_meta:metadata}).strict(),
 z.object({name:z.literal('offerings_save_draft'),arguments:offeringDraftInput,_meta:metadata}).strict(),
 z.object({name:z.literal('offerings_publish'),arguments:offeringPublishInput,_meta:metadata}).strict(),
 z.object({name:z.literal('offerings_withdraw'),arguments:offeringWithdrawInput,_meta:metadata}).strict(),
 z.object({name:z.literal('contact_notification_status'),arguments:empty,_meta:metadata}).strict(),
 z.object({name:z.literal('contact_notification_configure'),arguments:contactNotificationConfigurationInput,_meta:metadata}).strict(),
 z.object({name:z.literal('contact_notification_check_sender'),arguments:z.object({expectedRevision:z.number().int().nonnegative()}).strict(),_meta:metadata}).strict(),
 z.object({name:z.literal('contact_notification_dispatch'),arguments:z.object({id:z.string().uuid(),expectedRevision:z.number().int().positive()}).strict(),_meta:metadata}).strict(),
 z.object({name:z.literal('trustindex_widget_configuration_status'),arguments:empty,_meta:metadata}).strict(),
 z.object({name:z.literal('trustindex_widget_configuration_save'),arguments:trustindexWidgetInput,_meta:metadata}).strict(),
 z.object({name:z.literal('measurement_element_status'),arguments:empty,_meta:metadata}).strict(),
 z.object({name:z.literal('measurement_element_report'),arguments:elementReportInput,_meta:metadata}).strict(),
 z.object({name:z.literal('analytics_property_configuration_status'),arguments:empty,_meta:metadata}).strict(),
 z.object({name:z.literal('analytics_property_configuration_save'),arguments:ga4PropertyConfigurationInput,_meta:metadata}).strict(),
 z.object({name:z.literal('analytics_configuration_status'),arguments:empty,_meta:metadata}).strict(),
 z.object({name:z.literal('analytics_configuration_save'),arguments:analyticsConfigurationInput,_meta:metadata}).strict(),
 z.object({name:z.literal('zenbooker_api_status'),arguments:empty,_meta:metadata}).strict(),
 z.object({name:z.literal('zenbooker_api_check'),arguments:apiCheckInputSchema,_meta:metadata}).strict(),
 z.object({name:z.literal('zenbooker_api_refresh'),arguments:apiRefreshInputSchema,_meta:metadata}).strict(),
 z.object({name:z.literal('visitor_assistant_photo_configure'),arguments:z.object({revision:z.number().int().positive(),enabled:z.boolean()}).strict(),_meta:metadata}).strict(),
 z.object({name:z.literal('visitor_assistant_photo_check'),arguments:z.object({requestKey:z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/)}).strict(),_meta:metadata}).strict(),
 z.object({name:z.literal('visitor_assistant_record_schedule'),arguments:scheduleObservationInput,_meta:metadata}).strict(),
 z.object({name:z.literal('visitor_assistant_initialize'),arguments:z.object({requestKey:z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/)}).strict(),_meta:metadata}).strict(),
 z.object({name:z.literal('visitor_assistant_status'),arguments:empty,_meta:metadata}).strict(),
 z.object({name:z.literal('visitor_assistant_check'),arguments:empty,_meta:metadata}).strict(),
 z.object({name:z.literal('visitor_assistant_curate'),arguments:z.object({requestKey:z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/)}).strict(),_meta:metadata}).strict(),
 z.object({name:z.literal('hosted_bridge_capture_inspect'),arguments:captureInspectInput,_meta:metadata}).strict(),
 z.object({name:z.literal('hosted_bridge_probe'),arguments:z.object({requestKey:z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/)}).strict(),_meta:metadata}).strict(),
 z.object({name:z.literal('hosted_bridge_initialize'),arguments:z.object({requestKey:z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/)}).strict(),_meta:metadata}).strict(),
 z.object({name:z.literal('experiment_connection_status'),arguments:empty,_meta:metadata}).strict(),
 z.object({name:z.literal('experiment_baseline_setup'),arguments:empty,_meta:metadata}).strict(),
 z.object({name:z.literal('experiment_baseline_status'),arguments:empty,_meta:metadata}).strict(),
 z.object({name:z.literal('experiment_cache_probe'),arguments:empty,_meta:metadata}).strict(),
 z.object({name:z.literal('experiment_batch_dry_run'),arguments:batchArguments,_meta:metadata}).strict(),
 z.object({name:z.literal('experiment_batch_run'),arguments:batchArguments,_meta:metadata}).strict(),
 z.object({name:z.literal('experiment_batch_status'),arguments:z.object({runId:z.string().uuid()}).strict(),_meta:metadata}).strict(),
 z.object({name:z.literal('analytics_ingest_snapshot'),arguments:z.union([snapshotInput,snapshotV2Input]),_meta:metadata}).strict(),
]);
function kind(value:unknown){return value===null?'null':Array.isArray(value)?'array':typeof value;}
export function toolCallDiagnostic(params:unknown,error:z.ZodError){const object=params&&typeof params==='object'&&!Array.isArray(params)?params as Record<string,unknown>:null;const known=['name','arguments','_meta'];return {paramsKind:kind(params),presentKnownKeys:object?known.filter(key=>Object.hasOwn(object,key)):[],unknownKeyCount:object?Object.keys(object).filter(key=>!known.includes(key)).length:0,nameMatchesKnown:!!object&&siteToolNames.some(name=>name===object.name),argumentsKind:object?kind(object.arguments):'absent',metadataKind:object?kind(object._meta):'absent',issues:error.issues.slice(0,8).map(issue=>({path:issue.path.length===0?'params':known.includes(String(issue.path[0]))?String(issue.path[0]):'other',code:issue.code}))};}
