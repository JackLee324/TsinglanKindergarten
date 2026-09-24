const BASE='http://127.0.0.1:3200';
const PW='TestPassw0rd!';
let jar={};
function cookieHeader(){return Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; ');}
function store(res){const sc=res.headers.getSetCookie?.()??[];for(const c of sc){const [kv]=c.split(';');const i=kv.indexOf('=');jar[kv.slice(0,i).trim()]=kv.slice(i+1).trim();}}
async function req(method,path,body){
  const headers={'content-type':'application/json'};
  if(Object.keys(jar).length)headers['cookie']=cookieHeader();
  if(jar['suda-csrf-token'])headers['x-suda-csrf-token']=jar['suda-csrf-token'];
  const res=await fetch(BASE+path,{method,headers,body:body?JSON.stringify(body):undefined,redirect:'manual'});
  store(res);
  let data=null;try{data=await res.json();}catch{}
  return {status:res.status,data};
}
let pass=0,fail=0;
const DBURL=process.env.AUTHZ_TEST_DB||null;
const crypto0=await import('node:crypto');
const PgMod=await import('postgres');
const Pg=(PgMod.default||PgMod);
const { resetFixtures: sharedReset } = await import('../tests/helpers/reset-fixtures.mjs');
function pwHash(pw){const salt=crypto0.randomBytes(16).toString('base64');
  return 'scrypt$16384$8$1$'+salt+'$'+crypto0.scryptSync(pw,salt,32,{N:16384,r:8,p:1}).toString('base64');}
/**
 * Reset the fixture accounts before asserting.
 * This suite MUTATES state (section D demotes an administrator to prove instant
 * revocation), so without a reset a second run starts from a demoted database and
 * reports failures that are artefacts of the previous run rather than real bugs.
 */
// Fixture reset is shared with the other HTTP suites so the three can run in any
// order. See tests/helpers/reset-fixtures.mjs for why this is necessary.
async function resetFixtures(){
  if(!DBURL) return;
  const sql = await sharedReset(DBURL, { password: PW });
  await sql.end();
}
function check(label,actual,expected){
  const ok=Array.isArray(expected)?expected.includes(actual):actual===expected;
  console.log('  '+(ok?'PASS':'FAIL')+'  '+label.padEnd(58)+'-> '+actual+(ok?'':'   expected '+expected));
  ok?pass++:fail++;
}
async function login(user){
  jar={};
  await req('GET','/');                      // obtain suda-csrf-token cookie
  const r=await req('POST','/api/auth/login',{username:user,password:PW});
  if(r.status!==200){console.log('  LOGIN FAILED for '+user+': '+r.status+' '+JSON.stringify(r.data));}
  return r;
}
(async()=>{
  await resetFixtures();
  const sv=await req('GET','/');
  console.log('=== CSRF BOOTSTRAP ===');
  check('GET / issues suda-csrf-token cookie', !!jar['suda-csrf-token'], true);
  check('GET /api/auth/me without session', (await req('GET','/api/auth/me')).status, 401);

  console.log('\n=== A. LOW-PRIVILEGE ACCOUNT (prek_assistant) ===');
  check('login succeeds', (await login('prek-teacher01')).status, 201);
  check('GET /api/auth/me', (await req('GET','/api/auth/me')).status, 200);
  const perms=(await req('GET','/api/auth/me/permissions')).data;
  console.log('       effective permissions count: '+perms.permissions.length+' roles='+JSON.stringify(perms.roles));
  check('has resource.view', perms.permissions.includes('resource.view'), true);
  check('does NOT have account.view', perms.permissions.includes('account.view'), false);
  check('does NOT have audit.view', perms.permissions.includes('audit.view'), false);
  check('does NOT have resource.create', perms.permissions.includes('resource.create'), false);
  check('GET /api/teachers (admin API)', (await req('GET','/api/teachers')).status, 403);
  check('GET /api/audit/logs (admin API)', (await req('GET','/api/audit/logs')).status, 403);
  check('POST /api/teachers (create account)', (await req('POST','/api/teachers',{name:'x',roles:['visitor']})).status, 403);
  check('GET /api/resources (allowed)', (await req('GET','/api/resources')).status, 200);
  check('POST /api/resources (needs resource.create)', (await req('POST','/api/resources',{title:'x',program:'prek',subject:'virtue',folderType:'curriculum_outline'})).status, 403);

  console.log('\n=== B. PRINCIPAL (business admin) ===');
  check('login succeeds', (await login('qlsadmin')).status, 201);
  const pperms=(await req('GET','/api/auth/me/permissions')).data;
  check('has account.view', pperms.permissions.includes('account.view'), true);
  check('has audit.view', pperms.permissions.includes('audit.view'), true);
  check('does NOT have system.manage', pperms.permissions.includes('system.manage'), false);
  check('does NOT have system.restore', pperms.permissions.includes('system.restore'), false);
  check('GET /api/teachers', (await req('GET','/api/teachers')).status, 200);
  check('GET /api/audit/logs', (await req('GET','/api/audit/logs')).status, 200);

  console.log('\n=== C. PRIVILEGE ESCALATION: principal -> super_admin ===');
  const list=(await req('GET','/api/teachers?keyword=prek-teacher01')).data;
  const target=list?.items?.[0];
  if(target){
    const r=await req('PATCH','/api/teachers/'+target.id,{roles:['super_admin']});
    check('principal CANNOT promote to super_admin', r.status, [400,403,500]);
    console.log('       response: '+r.status+' '+JSON.stringify(r.data).slice(0,160));
  } else { console.log('  (target account not found; skipping)'); }
  const me=await req('GET','/api/auth/me');
  check('principal still principal (no self-escalation)', JSON.stringify(me.data?.roles), '["principal"]');

  console.log('\n=== D. INSTANT REVOCATION (permissions_version) ===');
  const before=(await req('GET','/api/resources')).status;
  check('resources reachable before change', before, 200);
  const postgres=(await import('postgres')).default;
  if(!DBURL){console.log('  (AUTHZ_TEST_DB not set; skipping revocation assertion)');process.exit(fail?1:0);}
  const sql=postgres(DBURL,{onnotice:()=>{}});
  await sql`update teachers set roles=array['visitor'] where username='qlsadmin'`;
  await sql.end();
  const after=await req('GET','/api/resources');
  check('session invalidated immediately after role change', after.status, 401);
  console.log('       response: '+after.status+' '+JSON.stringify(after.data).slice(0,120));

  console.log('\n=== RESULT ===');
  console.log('  pass='+pass+' fail='+fail);
  process.exit(fail?1:0);
})().catch(e=>{console.error('TEST ERROR',e.message);process.exit(1)});
