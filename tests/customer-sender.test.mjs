import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const z=require('zod/v3').z;

async function loadTs(relativePath,mocks={}){
 const source=await readFile(path.join(root,relativePath),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const loaded={exports:{}};
 new Function('require','module','exports',js)((specifier)=>{
  if(specifier==='zod/v3')return require('zod/v3');
  if(Object.hasOwn(mocks,specifier))return mocks[specifier];
  throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
 },loaded,loaded.exports);
 return loaded.exports;
}

async function bookingSettingsModule(){
 return loadTs('lib/booking-settings.ts',{
  './booking-payment-policy':{
   defaultPaymentPolicy:()=>({mode:'unknown'}),readPaymentPolicy:value=>value,
   paymentConfigHash:async value=>JSON.stringify(value),paymentPolicyMatches:()=>false,
  },
  './admin-auth-core':{sha256:async value=>String(value)},
 });
}

const adminActor=`admin-mcp:${'a'.repeat(64)}`;
const input={expectedRevision:7,from:'new-sender@example.invalid',zoneId:'c'.repeat(32),subdomainId:'d'.repeat(32)};
const baseSettings=()=>({
 revision:7,
 config:{trafficStage:'business',readEnabled:true,writeEnabled:true,sendingEnabled:true,emailFrom:'old-sender@example.invalid',emailZoneId:'a'.repeat(32),emailSubdomainId:'b'.repeat(32),identityRevision:4},
 senderCheck:{status:'verified',at:10,fingerprint:'fixture-fingerprint',source:'provider_api'},
 catalogCheck:{status:'verified',at:11,fingerprint:'catalog-fixture',source:'provider_api'},
 ownerConfirmation:{source:'owner_attested',actor:'fixture-owner',at:12,fingerprint:'fixture-fingerprint'},
});

async function loadCustomerSender(settings,configure){
 const booking=await bookingSettingsModule();
 return loadTs('lib/customer-sender.ts',{
  './booking-settings':booking,
  './customer-runtime':{bookingSettingsStore:()=>settings},
  './booking-admin':{configureBooking:configure},
 });
}

test('customer sender input is strict and uses the existing safe sender fields',async()=>{
 const sender=await loadCustomerSender({read:async()=>baseSettings()},async()=>{});
 assert.deepEqual(sender.customerSenderInput.parse(input),input);
 for(const invalid of [
  {...input,expectedRevision:-1},
  {...input,expectedRevision:1.5},
  {...input,from:'not-email'},
  {...input,zoneId:'short'},
  {...input,subdomainId:'A'.repeat(32)},
  {...input,bcc:'hidden@example.invalid'},
  {...input,token:'secret-sentinel'},
  {...input,enabled:true},
 ])assert.equal(sender.customerSenderInput.safeParse(invalid).success,false);
});

test('sender status is a read-only safe projection and does not probe the provider',async()=>{
 const state=baseSettings();let configureCalls=0,readCalls=0;
 const settings={async read(){readCalls++;return structuredClone(state);}};
 const sender=await loadCustomerSender(settings,async()=>{configureCalls++;throw new Error('configuration must not send');});
 const result=await sender.customerSenderService({settings}).status();
 assert.deepEqual(result,{revision:7,from:state.config.emailFrom,zoneId:state.config.emailZoneId,subdomainId:state.config.emailSubdomainId,readEnabled:true,writeEnabled:true,sendingEnabled:true,senderCheckStatus:'verified',sendingTested:false});
 assert.equal(readCalls,1);
 assert.equal(configureCalls,0);
 assert.doesNotMatch(JSON.stringify(result),/token|accountId|credential|recipient|PRIVATE_/i);
});

test('existing booking configuration still uses the unaudited two-argument settings save path',async()=>{
 const booking=await bookingSettingsModule();const saves=[];
 const admin=await loadTs('lib/booking-admin.ts',{
  './booking-payment-policy':{paymentConfigHash:async value=>JSON.stringify(value)},
  './customer-runtime':{
   bookingReadiness:async()=>({ready:true}),
   bookingSettingsStore:()=>({async save(...args){saves.push(args);}}),
   resolvedBookingRuntime:async()=>({settings:baseSettings(),paymentPolicyValid:true}),
   checkBookingCatalog:async()=>{},bookingStore:()=>({}),customerStore:()=>({}),
  },
  './booking-settings':booking,
  './runtime-secrets':{SITE_PROJECT_ID:'synthetic-booking-workspace'},
  './admin-auth-core':{sha256:async value=>String(value)},
 });
 const config=booking.bookingConfiguration.parse({...baseSettings().config,writeEnabled:false,sendingEnabled:false});
 assert.deepEqual(await admin.configureBooking({revision:7,config}),{ready:true});
 assert.equal(saves.length,1);
 assert.equal(saves[0].length,2,'the existing browser/admin booking path does not receive the native audit context');
 assert.equal(saves[0][0],7);
 assert.deepEqual(saves[0][1],config);
});

test('sender configuration preserves booking read and traffic settings, forces writes and sending off, and binds the server actor to one audited write',async()=>{
 const state=baseSettings();const calls=[];
 const settings={async read(){return structuredClone(state);}};
 const configure=async(value,audit)=>{
  calls.push({value:structuredClone(value),audit:structuredClone(audit)});
  state.revision++;
  state.config={...value.config,identityRevision:state.config.identityRevision+1};
  state.senderCheck={status:'not_checked',at:null,fingerprint:null,source:'not_checked'};
  state.ownerConfirmation=null;
  return {revision:state.revision,auditId:audit.auditId};
 };
 const sender=await loadCustomerSender(settings,configure);
 const service=sender.customerSenderService({settings,configure});
 const result=await service.configure(input,adminActor);
 assert.equal(calls.length,1);
 assert.equal(calls[0].value.revision,7);
 assert.equal(calls[0].value.config.trafficStage,'business');
 assert.equal(calls[0].value.config.readEnabled,true);
 assert.equal(calls[0].value.config.writeEnabled,false);
 assert.equal(calls[0].value.config.sendingEnabled,false);
 assert.equal(calls[0].value.config.emailFrom,input.from);
 assert.equal(calls[0].value.config.emailZoneId,input.zoneId);
 assert.equal(calls[0].value.config.emailSubdomainId,input.subdomainId);
 assert.equal(calls[0].audit.actor,adminActor);
 assert.match(calls[0].audit.auditId,/^[0-9a-f-]{36}$/i);
 assert.equal(result.auditId,calls[0].audit.auditId);
 assert.equal(result.revision,8);
 assert.equal(result.writeEnabled,false);
 assert.equal(result.sendingEnabled,false);
 assert.equal(result.senderCheckStatus,'not_checked');
 assert.equal(result.sendingTested,false);
 assert.equal(JSON.stringify(calls[0]).includes('token'),false);
});

test('stale sender settings do not call the shared booking writer',async()=>{
 const settings={async read(){return {...baseSettings(),revision:8};}};let writes=0;
 const configure=async()=>{writes++;return {};};
 const sender=await loadCustomerSender(settings,configure);
 await assert.rejects(sender.customerSenderService({settings,configure}).configure(input,adminActor));
 assert.equal(writes,0);
 await assert.rejects(sender.customerSenderService({settings,configure}).configure(input,'caller-supplied-actor'));
 assert.equal(writes,0);
});

test('sender MCP tools retain strict arguments and use verified administration with a server-derived actor',async()=>{
 const sender=await loadCustomerSender({read:async()=>baseSettings()},async()=>{});
 const mocks={
  './customer-sender':{customerSenderInput:sender.customerSenderInput},
  './element-measurement-core':{elementReportInput:z.object({}).strict()},
  './ga4-property-configuration':{ga4PropertyConfigurationInput:z.object({}).strict()},
  './contact-notification-configuration':{contactNotificationConfigurationInput:z.object({}).strict()},
  './trustindex-widget-configuration':{trustindexWidgetInput:z.object({}).strict()},
  './service-offerings':{offeringDraftInput:z.object({}).strict(),offeringPublishInput:z.object({}).strict(),offeringWithdrawInput:z.object({}).strict()},
  './analytics-configuration':{analyticsConfigurationInput:z.object({}).strict()},
  '../integrations/zenbooker-bridge/capture-inspection':{captureInspectInput:z.object({}).strict()},
  './zenbooker-api-core':{apiCheckInputSchema:z.object({}).strict(),apiRefreshInputSchema:z.object({}).strict()},
  './support-schedule':{scheduleObservationInput:z.object({}).strict()},
  './snapshot-v2':{snapshotV2Input:z.object({}).strict()},
  './analysis-core':{snapshotInput:z.object({}).strict()},
 };
 const contract=await loadTs('lib/mcp-call-contract.ts',mocks);
 assert.ok(contract.siteToolNames.includes('customer_sender_status'));
 assert.ok(contract.siteToolNames.includes('customer_sender_configure'));
 assert.equal(contract.siteToolCall.safeParse({name:'customer_sender_status',arguments:{}}).success,true);
 assert.equal(contract.siteToolCall.safeParse({name:'customer_sender_status',arguments:{from:input.from}}).success,false);
 assert.equal(contract.siteToolCall.safeParse({name:'customer_sender_configure',arguments:input}).success,true);
 assert.equal(contract.siteToolCall.safeParse({name:'customer_sender_configure',arguments:{...input,actor:adminActor}}).success,false);

 const [nativeSource,adminToolsSource]=await Promise.all([
  readFile(path.join(root,'lib/site-mcp.ts'),'utf8'),
  readFile(path.join(root,'lib/admin-tools.ts'),'utf8'),
 ]);
 const adminGuard=nativeSource.indexOf('const admin=machine??await getGoogleAdmin(request)');
 const originGuard=nativeSource.indexOf("if(!machine&&request.headers.get('origin')!==new URL(request.url).origin)",adminGuard);
 const actor=nativeSource.indexOf("const actor='admin-mcp:'+await sha256(user.userId)");
 const status=nativeSource.indexOf("call.data.name==='customer_sender_status'");
 const dispatch=nativeSource.indexOf("call.data.name==='customer_sender_configure'");
 assert.ok(adminGuard>=0&&originGuard>adminGuard&&actor>originGuard&&status>actor&&dispatch>status,'sender tools follow verified administrator authentication, same-origin browser checks and server actor derivation');
 assert.match(nativeSource.slice(dispatch,dispatch+220),/customerSenderService\(\)\.configure\(call\.data\.arguments,actor\)/);
 assert.match(adminToolsSource,/booking\.configure':tool\(bookingSettingsInput,async\(_admin,args\)=>configureBooking\(args\)\)/,'the pre-existing booking configure operation remains separate from the audited native sender wrapper');
});

test('shared audit exposes only a fixed sender label for validated same-workspace administrator writes',async()=>{
 const workspace='sender-audit-workspace';
 const personal={id:'personal-audit-id',google_subject:'current-admin',action:'settings.saved',target:'personal target',created_at:1};
 const rows=[
  {id:'admin-audit-id',google_subject:adminActor,action:'customer.sender_configure',target:JSON.stringify({workspaceId:workspace,revision:3,senderConfigured:true,readEnabled:true,writeEnabled:false,sendingEnabled:false,from:'sentinel@example.invalid',zoneId:'a'.repeat(32),subdomainId:'b'.repeat(32),secret:'SENDER_SECRET_SENTINEL'}),created_at:2},
  {id:'foreign-audit-id',google_subject:adminActor,action:'customer.sender_configure',target:JSON.stringify({workspaceId:'other-workspace',revision:4,senderConfigured:true,writeEnabled:false,sendingEnabled:false}),created_at:3},
  {id:'unsafe-audit-id',google_subject:adminActor,action:'customer.sender_configure',target:JSON.stringify({workspaceId:workspace,revision:5,senderConfigured:true,writeEnabled:true,sendingEnabled:false}),created_at:4},
  {id:'malformed-audit-id',google_subject:adminActor,action:'customer.sender_configure',target:'not json',created_at:5},
  {id:'foreign-private-id',google_subject:'other-admin',action:'ordinary.private_action',target:'foreign private target',created_at:6},
  personal,
 ];
 const db={prepare(){return {bind(){return {async all(){return {results:rows};}};}};}};
 const consoleModule=await loadTs('lib/console-store.ts',{
  './contact-store':{ContactStore:class{}},
  './element-measurement-store':{ElementMeasurementStore:class{constructor(){throw new Error('Unexpected element-measurement store construction in audit-only coverage');}}},
  './public-reviews-url':{publicReviewsUrlInput:z.string().nullable()},
  './inquiry-validation':{updateInput:z.object({}).strict(),services:['fixture'],areas:['fixture']},
 });
 const result=await new consoleModule.ConsoleStore(db,workspace,'current-admin','site-owner').audit();
 assert.deepEqual(result.map(row=>row.id).sort(),['admin-audit-id','personal-audit-id'].sort());
 const adminResult=result.find(row=>row.id==='admin-audit-id');
 assert.equal(adminResult.actor,'Admin');
 assert.equal(adminResult.target,'Customer email sender settings updated');
 assert.doesNotMatch(JSON.stringify(result),/SENDER_SECRET_SENTINEL|sentinel@example\.invalid|other-workspace|foreign private target|a{32}/i);
 assert.equal(result.find(row=>row.id==='personal-audit-id').target,'personal target','the current admin’s ordinary personal audit remains readable');
});

