import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const zod=require('zod/v3');
const inputBudget=await loadTs('lib/input-budget.ts');
async function loadTs(relativePath,imports={}){
  const source=await readFile(path.join(root,relativePath),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const loaded={exports:{}};
  new Function('require','module','exports',js)(specifier=>{
    if(Object.hasOwn(imports,specifier))return imports[specifier];
    throw new Error(`Unexpected import from ${relativePath}: ${specifier}`);
  },loaded,loaded.exports);
  return loaded.exports;
}

const booking=await loadTs('lib/zenbooker-core.ts',{zod,'zod/v3':zod,'./input-budget':inputBudget});
const policy=await loadTs('lib/booking-payment-policy.ts',{
  zod,
  'zod/v3':zod,
  './admin-auth-core':{sha256:async value=>createHash('sha256').update(value).digest('hex')},
  './action-approval-core':{canonicalAction:value=>JSON.stringify(value)},
  './zenbooker-core':booking,
});

function catalog(){return {results:[
  {service_id:'blowout',name:'Demo blowout',base_duration:45,base_price:'89.00',sections:[
    {section_id:'zones',section_type:'price_modifier',title:'Zones',input_type:'radio_buttons',required:true,options:[
      {option_id:'large',name:'Large system',price:'20.00',duration:15},
      {option_id:'small',name:'Small system',price:'0.00',duration:0},
    ]},
  ]},
  {service_id:'repair',name:'Irrigation repair',base_duration:60,base_price:'125.00',sections:[]},
],remaining:0,cursor:0};}

const binding={providerFingerprint:'provider-fingerprint-v1',catalogHash:'a'.repeat(64),serviceIds:['blowout','repair'],configHash:'b'.repeat(64)};
const attested={...policy.defaultPaymentPolicy(),mode:'no_online_payment_required',source:'owner_attested',actor:'fixed-site-owner',at:1_900_000_000_000,...binding};

test('missing or legacy payment policy fails closed as unknown',()=>{
  assert.deepEqual(policy.readPaymentPolicy(null),policy.defaultPaymentPolicy());
  assert.deepEqual(policy.readPaymentPolicy({mode:'no_online_payment_required',source:'owner_attested'}),policy.defaultPaymentPolicy());
  assert.equal(policy.paymentPolicyMatches(policy.defaultPaymentPolicy(),binding),false);
});

test('strict payment attestation input rejects client supplied evidence and unsupported modes',()=>{
  assert.equal(policy.paymentPolicyInput.safeParse({mode:'no_online_payment_required',expectedSettingsRev:4,catalogHash:'a'.repeat(64)}).success,true);
  assert.equal(policy.paymentPolicyInput.safeParse({mode:'no_online_payment_required',expectedSettingsRev:4,catalogHash:'a'.repeat(64),providerFingerprint:'client-proof'}).success,false);
  assert.equal(policy.paymentPolicyInput.safeParse({mode:'paid_deposit_required',expectedSettingsRev:4,catalogHash:'a'.repeat(64)}).success,false);
});

test('catalog evidence binds normalized current fields and stable sorted service scope',async()=>{
  const first=await policy.catalogEvidence(catalog());
  assert.match(first.catalogHash,/^[0-9a-f]{64}$/);
  assert.deepEqual(first.serviceIds,['blowout','repair']);
  const reordered=catalog();
  reordered.results.reverse();
  reordered.results[1].sections[0].options.reverse();
  assert.deepEqual(await policy.catalogEvidence(reordered),first);
  const changed=catalog();
  changed.results[0].base_price='89.01';
  assert.notEqual((await policy.catalogEvidence(changed)).catalogHash,first.catalogHash);
});

test('malformed, duplicate, or ambiguous catalog evidence is refused',async()=>{
  await assert.rejects(policy.catalogEvidence({results:[{service_id:'broken'}]}),/catalog_invalid/);
  const duplicateService=catalog();
  duplicateService.results[1].service_id=duplicateService.results[0].service_id;
  await assert.rejects(policy.catalogEvidence(duplicateService),/catalog_ambiguous/);
  const duplicateOption=catalog();
  duplicateOption.results[0].sections[0].options[1].option_id='large';
  await assert.rejects(policy.catalogEvidence(duplicateOption),/catalog_ambiguous/);
});

test('payment configuration binds all policy-affecting settings but not the write switch',async()=>{
  const config={trafficStage:'demo',readEnabled:true,writeEnabled:false,sendingEnabled:false,emailFrom:null,emailZoneId:null,emailSubdomainId:null,identityRevision:0};
  const base=await policy.paymentConfigHash(config);
  assert.equal(await policy.paymentConfigHash({...config,writeEnabled:true}),base);
  assert.notEqual(await policy.paymentConfigHash({...config,readEnabled:false}),base);
  assert.notEqual(await policy.paymentConfigHash({...config,trafficStage:'business'}),base);
});

test('attested policy matches only its current provider, catalog, service scope and config',()=>{
  assert.equal(policy.paymentPolicyMatches(attested,binding),true);
  assert.equal(policy.paymentPolicyMatches({...attested,providerFingerprint:'changed'},binding),false);
  assert.equal(policy.paymentPolicyMatches(attested,{...binding,catalogHash:'c'.repeat(64)}),false);
  assert.equal(policy.paymentPolicyMatches(attested,{...binding,serviceIds:['blowout']}),false);
  assert.equal(policy.paymentPolicyMatches(attested,{...binding,configHash:'d'.repeat(64)}),false);
  assert.equal(policy.paymentPolicyMatches({...attested,mode:'unknown'},binding),false);
  assert.equal(policy.paymentPolicyMatches({...attested,source:null},binding),false);
});
