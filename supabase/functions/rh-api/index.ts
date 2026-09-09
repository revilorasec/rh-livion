import { createClient } from 'jsr:@supabase/supabase-js@2';

const TENANT_ID='911e1aee-070e-421b-ae71-439f01c2263e';
const CLIENT_ID='88cf5cba-9f67-467d-8a51-9638200bed52';
const ALLOWED_ORIGINS=new Set([
  'https://portal.livionsolutions.com.br',
  'https://revilorasec.github.io',
  'http://localhost:3000',
  'http://localhost:5173'
]);
const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});

function cors(origin:string|null){const o=origin&&ALLOWED_ORIGINS.has(origin)?origin:'https://portal.livionsolutions.com.br';return {'Access-Control-Allow-Origin':o,'Vary':'Origin','Access-Control-Allow-Headers':'authorization, content-type','Access-Control-Allow-Methods':'GET,PUT,POST,OPTIONS','Content-Type':'application/json'};}
function reply(origin:string|null,status:number,data:unknown){return new Response(JSON.stringify(data),{status,headers:cors(origin)});}
function bearer(req:Request){const v=req.headers.get('authorization')||'';if(!v.startsWith('Bearer ')||v.length>9000)throw new Error('UNAUTHENTICATED');return v.slice(7);}
function claims(token:string){try{const p=token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');return JSON.parse(atob(p));}catch{return {};}}
async function identity(req:Request){const token=bearer(req);const c=claims(token);if(c.tid!==TENANT_ID||(c.azp!==CLIENT_ID&&c.appid!==CLIENT_ID))throw new Error('UNAUTHENTICATED');const r=await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName',{headers:{Authorization:`Bearer ${token}`}});if(!r.ok)throw new Error('UNAUTHENTICATED');const me=await r.json();const email=String(me.mail||me.userPrincipalName||'').trim().toLowerCase();if(!me.id||!email)throw new Error('UNAUTHENTICATED');return {id:String(me.id),email,name:String(me.displayName||email)};}
async function rhAccess(req:Request){const me=await identity(req);const q=await db.from('portal_users').select('*').eq('email',me.email).maybeSingle();if(q.error||!q.data||!q.data.active)throw new Error('FORBIDDEN');const u=q.data;const admin=u.profile==='ADMINISTRADOR';const apps=Array.isArray(u.apps)?u.apps:[];if(!admin&&!apps.includes('rh'))throw new Error('FORBIDDEN');const actions=admin?['*']:(Array.isArray(u.actions)?u.actions:[]);return {me,u,admin,actions,userType:String(u.user_type||'INTERNO')};}
function has(a:string[],key:string){return a.includes('*')||a.includes(key);}
function sanitize(payload:any,ctx:any){const x=structuredClone(payload||{});const salary=has(ctx.actions,'rh.visualizar_salarios');const bank=has(ctx.actions,'rh.visualizar_dados_bancarios');const sensitive=has(ctx.actions,'rh.visualizar_dados_sensiveis');const docs=ctx.userType==='INTERNO'&&has(ctx.actions,'rh.visualizar_documentos');if(Array.isArray(x.cargos)&&!salary)x.cargos=x.cargos.map((c:any)=>({...c,salario:null}));if(Array.isArray(x.regrasSalario)&&!salary)x.regrasSalario=x.regrasSalario.map((r:any)=>({...r,salario:null}));if(Array.isArray(x.funcionarios)){x.funcionarios=x.funcionarios.map((f:any)=>{const n={...f};if(!bank)n.bancos=[];if(!docs){n.documentos=[];n.foto=null;n.curriculo=null;}if(!sensitive){const p={...(n.pessoal||{})};['cpf','rg','cnh','pis','tituloEleitor','nascimento','endereco','estadoCivil','tipoSanguineo','emergenciaNome','emergenciaTelefone','emergenciaParentesco','emergencias','dependentes','saude','qualDoenca','quaisMedicamentos','tiposAlergias'].forEach(k=>{if(k in p)p[k]=null;});n.pessoal=p;n.observacoes=null;n.avaliacao=null;}return n;});}
return x;}
function employeeEmail(f:any){return String(f?.pessoal?.emailProfissional||f?.pessoal?.emailPessoal||f?.email||'').trim().toLowerCase();}
function onlyEmployee(payload:any,ctx:any){const x=structuredClone(payload||{});const f=(x.funcionarios||[]).find((z:any)=>employeeEmail(z)===ctx.me.email);if(!f)throw new Error('FUNCIONARIO_NAO_VINCULADO');x.funcionarios=[f];x.ferias=(x.ferias||[]).filter((r:any)=>r.funcionarioId===f.id);x.projetos=[];x.clientes=[];x.cargos=[];x.regrasSalario=[];return x;}
async function audit(actor:string,action:string,target:string,detail:any={}){await db.from('access_audit').insert({actor_email:actor,action,target,detail});}

Deno.serve(async(req)=>{const origin=req.headers.get('origin');if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors(origin)});try{const url=new URL(req.url);const base='/rh-api';const i=url.pathname.indexOf(base);const path=i>=0?url.pathname.slice(i+base.length)||'/':'/';if(path==='/health'&&req.method==='GET')return reply(origin,200,{ok:true,service:'rh-api',version:2});const ctx=await rhAccess(req);
if(path==='/data'&&req.method==='GET'&&ctx.userType!=='INTERNO'){const q=await db.from('portal_rh_data').select('payload,revision,updated_at,updated_by').eq('id',1).maybeSingle();if(q.error)throw q.error;const row=q.data||{payload:{},revision:0};const data=onlyEmployee(row.payload,ctx);return reply(origin,200,{ok:true,empty:false,revision:row.revision,updatedAt:row.updated_at,updatedBy:row.updated_by,data,userType:ctx.userType,user:ctx.me,employeeOnly:true,permissions:{salary:false,bank:false,sensitive:false,documents:false,edit:false}});}if(path==='/data'&&req.method==='GET'){if(!has(ctx.actions,'rh.visualizar_dados_basicos')&&!ctx.admin)throw new Error('FORBIDDEN');const q=await db.from('portal_rh_data').select('payload,revision,updated_at,updated_by').eq('id',1).maybeSingle();if(q.error)throw q.error;const row=q.data||{payload:{},revision:0,updated_at:null,updated_by:null};const empty=!row.payload||Object.keys(row.payload).length===0;return reply(origin,200,{ok:true,empty,revision:row.revision,updatedAt:row.updated_at,updatedBy:row.updated_by,data:empty?{}:sanitize(row.payload,ctx),userType:ctx.userType,user:ctx.me,permissions:{salary:has(ctx.actions,'rh.visualizar_salarios'),bank:has(ctx.actions,'rh.visualizar_dados_bancarios'),sensitive:has(ctx.actions,'rh.visualizar_dados_sensiveis'),documents:ctx.userType==='INTERNO'&&has(ctx.actions,'rh.visualizar_documentos'),edit:has(ctx.actions,'rh.editar_funcionarios')}});}

if(path==='/data'&&req.method==='PUT'){
  const required=['rh.editar_funcionarios'];
  if(ctx.userType!=='INTERNO'||!required.every(key=>has(ctx.actions,key))) throw new Error('FORBIDDEN');
  const body=await req.json();
  if(!body?.data || typeof body.data!=='object' || Array.isArray(body.data)) return reply(origin,400,{error:'Dados inválidos'});
  if(!Number.isSafeInteger(body.revision) || body.revision<0) return reply(origin,428,{error:'Revisão obrigatória. Atualize o aplicativo e recarregue os dados.'});
  const cur=await db.from('portal_rh_data').select('payload,revision').eq('id',1).maybeSingle();
  if(cur.error) throw cur.error;
  if(!cur.data || cur.data.revision!==body.revision) return reply(origin,409,{error:'A base foi alterada. Recarregue antes de salvar.'});
  const incoming=structuredClone(body.data), current=cur.data?.payload||{};
  const safe=['id','nome','status','empresa','cargo','nivel','linkedin','dataAdmissao','dataDemissao','pasta'];
  const byId=new Map((current.funcionarios||[]).map((f:any)=>[String(f.id),f]));
  const funcionarios=(incoming.funcionarios||[]).map((f:any)=>{const old=byId.get(String(f.id));if(!old)return {...f,pessoal:f.pessoal||{},bancos:f.bancos||[],documentos:f.documentos||[],projetos:f.projetos||[]};const n={...old};safe.forEach(k=>{if(k in f)n[k]=f[k];});return n;});
  const payload={...current,...incoming,funcionarios,cargos:current.cargos||[],regrasSalario:current.regrasSalario||[],projetos:current.projetos||[],clientes:current.clientes||[]};
  const next=body.revision+1;
  if(!Number.isSafeInteger(next)) return reply(origin,400,{error:'Revisão inválida'});
  // Uma única operação condicional: duas gravações da mesma revisão não podem vencer.
  const r=await db.from('portal_rh_data')
    .update({payload,revision:next,updated_at:new Date().toISOString(),updated_by:ctx.me.email})
    .eq('id',1).eq('revision',body.revision).select('revision').maybeSingle();
  if(r.error) throw r.error;
  if(!r.data) return reply(origin,409,{error:'A base foi alterada. Recarregue antes de salvar.'});
  await audit(ctx.me.email,'RH_DATA_SAVE','RH',{revision:next});
  return reply(origin,200,{ok:true,revision:next});
}
if(path==='/bootstrap'&&req.method==='POST'){
  if(!ctx.admin) throw new Error('FORBIDDEN');
  const body=await req.json();
  if(!body?.data || typeof body.data!=='object' || Array.isArray(body.data) || Object.keys(body.data).length===0) return reply(origin,400,{error:'Dados inválidos'});
  if(body.force) return reply(origin,409,{error:'Substituição forçada não permitida'});
  const cur=await db.from('portal_rh_data').select('payload,revision').eq('id',1).maybeSingle();
  if(cur.error) throw cur.error;
  if(cur.data?.payload && Object.keys(cur.data.payload).length>0) return reply(origin,409,{error:'Base RH já inicializada'});
  const next=(cur.data?.revision||0)+1;
  const values={payload:body.data,revision:next,updated_at:new Date().toISOString(),updated_by:ctx.me.email};
  let r;
  if(cur.data){
    r=await db.from('portal_rh_data').update(values).eq('id',1).eq('revision',cur.data.revision)
      .eq('payload','{}').select('revision').maybeSingle();
  }else{
    r=await db.from('portal_rh_data').insert({id:1,...values}).select('revision').maybeSingle();
  }
  if(r.error?.code==='23505' || (!r.error&&!r.data)) return reply(origin,409,{error:'Base RH já inicializada'});
  if(r.error) throw r.error;
  await audit(ctx.me.email,'RH_DATA_BOOTSTRAP','RH',{revision:next});
  return reply(origin,200,{ok:true,revision:next});
}
return reply(origin,404,{error:'NOT_FOUND'});}catch(e){const m=e instanceof Error?e.message:'ERROR';const status=e instanceof SyntaxError?400:m==='UNAUTHENTICATED'?401:m==='FORBIDDEN'?403:500;return reply(origin,status,{error:m});}});

