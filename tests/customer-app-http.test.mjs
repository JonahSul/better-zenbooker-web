import test from 'node:test';
import assert from 'node:assert/strict';

const base=process.env.TEST_CUSTOMER_APP_BASE_URL??'';
const parsed=base?new URL(base):null;
const enabled=!!parsed&&parsed.protocol==='http:'&&parsed.hostname==='127.0.0.1'&&parsed.port==='8788';
if(base&&!enabled)throw new Error('Customer app HTTP tests require the dedicated loopback Worker at 127.0.0.1:8788.');

async function request(path,{method='GET',body,origin,cookie}={}){
  const headers={};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(origin)headers.Origin=origin;
  if(cookie)headers.Cookie=cookie;
  const response=await fetch(new URL(path,base),{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const text=await response.text();
  let data=null;
  try{data=text?JSON.parse(text):null;}catch{}
  return {response,text,data};
}

test('customer app routes remain separate from Google admin and fail closed while providers are disabled',{skip:!enabled&&'Set TEST_CUSTOMER_APP_BASE_URL to the disposable local Worker only.'},async()=>{
  const origin=parsed.origin;

  for(const path of ['/book','/appointments']){
    const result=await request(path);
    assert.equal(result.response.status,200,`${path} should render without a Google admin session`);
    assert.match(result.response.headers.get('x-robots-tag')??'',/noindex/i,`${path} must remain private/noindex`);
    assert.equal(result.response.headers.get('cache-control'),'private, no-store');
    assert.equal(result.response.headers.get('referrer-policy'),'no-referrer');
    assert.match(result.response.headers.get('content-security-policy')??'',/default-src 'self'/);
    assert.match(result.response.headers.get('content-security-policy')??'',/script-src 'self'/);
    assert.match(result.response.headers.get('content-security-policy')??'',/connect-src 'self'/);
    assert.doesNotMatch(result.text,/googletagmanager\.com\/gtm\.js|googletagmanager\.com\/ns\.html/i);
    assert.doesNotMatch(result.text,/googletagmanager\.com|google-analytics\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/i);
  }

  const session=await request('/api/customer/session');
  assert.equal(session.response.status,200);
  assert.deepEqual(session.data,{authenticated:false});

  for(const [path,method,body] of [
    ['/api/appointments','GET'],
    ['/api/appointments/00000000-0000-4000-8000-000000000001','GET'],
    ['/api/appointments','POST',{not:'a valid booking'}],
    ['/api/appointments/00000000-0000-4000-8000-000000000001/cancel','POST',{confirm:true}],
    ['/api/appointments/00000000-0000-4000-8000-000000000001/reschedule','POST',{confirm:true}],
    ['/api/appointments/00000000-0000-4000-8000-000000000001/prepare-reschedule','POST',{}],
  ]){
    const result=await request(path,{method,body,origin:method==='GET'?undefined:origin});
    assert.equal(result.response.status,401,`${method} ${path} requires a verified customer`);
    assert.doesNotMatch(result.text,/ZENBOOKER_API_KEY|CLOUDFLARE_EMAIL_API_TOKEN|fixture-provider-token/i);
  }

  const admin=await request('/api/admin/tools',{method:'POST',origin,body:{tool:'booking.readiness',arguments:{}}});
  assert.ok([401,403].includes(admin.response.status));

  const catalog=await request('/api/booking/catalog');
  assert.equal(catalog.response.status,503);
  assert.equal(catalog.data?.readiness?.bookingEnabled,false);
  assert.equal(catalog.data?.readiness?.emailSignInEnabled,false);

  const sameOriginContext=await request('/api/booking/context',{method:'POST',origin,body:{serviceId:'unknown',selections:[],address:{},customer:{}}});
  assert.equal(sameOriginContext.response.status,503);
  assert.equal(sameOriginContext.data?.readiness?.bookingEnabled,false);

  const availability=await request('/api/booking/availability?contextId=00000000-0000-4000-8000-000000000001&date=2026-11-02');
  assert.equal(availability.response.status,503);
  const selection=await request('/api/booking/selection',{method:'POST',origin,body:{contextId:'00000000-0000-4000-8000-000000000001',date:'2026-11-02',slotId:'fixture-slot'}});
  assert.equal(selection.response.status,503);

  const foreignOrigin=await request('/api/booking/context',{method:'POST',origin:'https://example.invalid',body:{serviceId:'unknown'}});
  assert.equal(foreignOrigin.response.status,403);

  const otp=await request('/api/customer/auth/start',{method:'POST',origin,body:{email:'fixture@example.invalid'}});
  assert.equal(otp.response.status,503);
  assert.equal(otp.data?.status,'disabled');
  assert.equal(otp.text.includes('fixture@example.invalid'),false);

  const verify=await request('/api/customer/auth/verify',{method:'POST',origin,body:{challengeId:'00000000-0000-4000-8000-000000000001',code:'000000'}});
  assert.equal(verify.response.status,400);
  assert.doesNotMatch(verify.text,/customer@example|fixture@example\.invalid|otpCode|sessionToken/i);
});
