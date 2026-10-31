import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const ts=await import('typescript');
const source=await readFile(path.join(root,'lib/model-projection.ts'),'utf8');
const js=ts.default.transpileModule(source,{compilerOptions:{module:ts.default.ModuleKind.CommonJS,target:ts.default.ScriptTarget.ES2022}}).outputText;
const loaded={exports:{}};
new Function('require','module','exports',js)(specifier=>{
  if(specifier==='./admin-redaction')return {redactAdminText:(text)=>({text,redacted:false})};
  return require(specifier);
},loaded,loaded.exports);
const {relevantContacts}=loaded.exports;

const sourceTables=['inquiries','customers','booking_contexts','appointments'];
function sourceOf(sql){const found=sourceTables.filter(name=>new RegExp(`\\b${name}\\b`,'i').test(sql));return found.length===1?found[0]:'mixed';}
function fakeDb(rowsBySource,{failSource=null}={}){
  const calls=[];
  return {calls,prepare(sql){const source=sourceOf(sql);return {bind(...params){return {sql,source,params};}};},async batch(statements){const results=[];for(const statement of statements){calls.push(statement);if(statement.source===failSource)throw new Error('fixture D1 failure');results.push({results:rowsBySource[statement.source]??[]});}return results;}};
}
const row=(name,contact)=>({name,contact});

test('known-contact lookup queries each fixed source independently and deduplicates matching pairs across sources',async()=>{
  const repeated=row('Synthetic contact','555-0100');
  const db=fakeDb({
    inquiries:[repeated,row('Inquiry name','555-0101')],
    customers:[repeated],
    booking_contexts:[repeated],
    appointments:[repeated,row('Appointment name','555-0102')],
  });
  const result=await relevantContacts(db,'fixed-site-user','Synthetic contact 555-0100');
  assert.equal(db.calls.length,6,'inquiry, customer, booking customer/address, appointment customer/address are isolated queries in one batch');
  assert.ok(db.calls.every(call=>call.source!=='mixed'));
  assert.equal(result.uncertain,false);
  assert.equal(result.values.filter(value=>value==='Synthetic contact').length,1);
  assert.equal(result.values.filter(value=>value==='555-0100').length,1);
  for(const call of db.calls){
    assert.match(call.sql,/LIMIT\s+101/i);
    assert.match(call.sql,/length\(name\)>0/i);
    assert.match(call.sql,/length\(contact\)>0/i);
    assert.deepEqual(call.params,['Synthetic contact 555-0100','Synthetic contact 555-0100']);
  }
});

test('aggregate overflow is uncertain even when every fixed source remains below its own bound',async()=>{
  const distinct=(prefix,count)=>Array.from({length:count},(_,i)=>row(`${prefix}-name-${i}`,`${prefix}-contact-${i}`));
  const db=fakeDb({inquiries:distinct('i',51),customers:distinct('c',50),booking_contexts:[],appointments:[]});
  const result=await relevantContacts(db,'fixed-site-user','bounded synthetic query');
  assert.equal(db.calls.length,6);
  assert.equal(db.calls.some(call=>call.source==='mixed'),false);
  assert.equal(result.uncertain,true,'the global pair budget is checked after cross-source deduplication');
});

test('deleted-record filters remain on customer and appointment lookups while source scopes stay separate',async()=>{
  const db=fakeDb({inquiries:[],customers:[],booking_contexts:[],appointments:[]});
  const result=await relevantContacts(db,'fixed-site-user','matchable query');
  assert.equal(result.uncertain,false);
  assert.equal(db.calls.length,6);
  const customerQueries=db.calls.filter(call=>/\bcustomers\b/i.test(call.sql));
  const appointmentQueries=db.calls.filter(call=>/\bappointments\b/i.test(call.sql));
  const bookingQueries=db.calls.filter(call=>/\bbooking_contexts\b/i.test(call.sql));
  const inquiryQueries=db.calls.filter(call=>/\binquiries\b/i.test(call.sql));
  assert.equal(customerQueries.length,1);
  assert.match(customerQueries[0].sql,/deleted_at\s+IS\s+NULL/i);
  assert.equal(appointmentQueries.length,2);
  assert.ok(appointmentQueries.every(call=>/deleted_at\s+IS\s+NULL/i.test(call.sql)));
  assert.equal(bookingQueries.length,2);
  assert.equal(inquiryQueries.length,1);
});

test('a failed source query propagates instead of returning partial contact matches',async()=>{
  const db=fakeDb({inquiries:[row('Synthetic match','555-0199')],customers:[],booking_contexts:[],appointments:[]},{failSource:'appointments'});
  await assert.rejects(relevantContacts(db,'fixed-site-user','Synthetic match 555-0199'),/fixture D1 failure/);
});
