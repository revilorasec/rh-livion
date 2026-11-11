import { createClient } from 'jsr:@supabase/supabase-js@2';

const TENANT_ID='911e1aee-070e-421b-ae71-439f01c2263e';
const CLIENT_ID='88cf5cba-9f67-467d-8a51-9638200bed52';
const ALLOWED_ORIGINS=new Set([
  'https://portal.livionsolutions.com.br',
  'https://revilorasec.github.io',
  'https://kvfjjtkwxxbvzlicwnrz.supabase.co',
  'http://localhost:3000',
  'http://localhost:5173'
]);
const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
const VACATION_BUCKET='rh-vacation-files';
const STAFF_BUCKET='rh-staff-files';
const MAX_FILE_SIZE=10*1024*1024;
const ALLOWED_MIME=new Set(['application/pdf','image/jpeg','image/png','image/webp','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const MIME_BY_EXT:Record<string,string>={pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};

function cors(origin:string|null){const o=origin&&ALLOWED_ORIGINS.has(origin)?origin:'https://portal.livionsolutions.com.br';return {'Access-Control-Allow-Origin':o,'Vary':'Origin','Access-Control-Allow-Headers':'authorization, content-type','Access-Control-Allow-Methods':'GET,PUT,POST,DELETE,OPTIONS','Content-Type':'application/json'};}
function reply(origin:string|null,status:number,data:unknown){return new Response(JSON.stringify(data),{status,headers:cors(origin)});}
function bearer(req:Request){const v=req.headers.get('authorization')||'';if(!v.startsWith('Bearer ')||v.length>9000)throw new Error('UNAUTHENTICATED');return v.slice(7);}
function claims(token:string){try{const p=token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');return JSON.parse(atob(p));}catch{return {};}}
function email(value:unknown){return String(value||'').trim().toLowerCase();}
async function identity(req:Request){const token=bearer(req);const c=claims(token);if(c.tid!==TENANT_ID||(c.azp!==CLIENT_ID&&c.appid!==CLIENT_ID))throw new Error('UNAUTHENTICATED');const r=await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName',{headers:{Authorization:`Bearer ${token}`}});if(!r.ok)throw new Error('UNAUTHENTICATED');const me=await r.json();const userEmail=email(me.mail||me.userPrincipalName);if(!me.id||!userEmail)throw new Error('UNAUTHENTICATED');return {id:String(me.id),email:userEmail,name:String(me.displayName||userEmail)};}
async function rhAccess(req:Request){const me=await identity(req);const q=await db.from('portal_users').select('*').eq('email',me.email).maybeSingle();if(q.error||!q.data||!q.data.active)throw new Error('FORBIDDEN');const u=q.data;const admin=u.profile==='ADMINISTRADOR';const apps=Array.isArray(u.apps)?u.apps:[];if(!admin&&!apps.includes('rh'))throw new Error('FORBIDDEN');const actions=admin?['*']:(Array.isArray(u.actions)?u.actions:[]);return {me,u,admin,actions,userType:String(u.user_type||'INTERNO')};}
function has(actions:string[],key:string){return actions.includes('*')||actions.includes(key);}
function canReadDocuments(ctx:any){return ctx.userType==='INTERNO'&&(ctx.admin||has(ctx.actions,'rh.visualizar_documentos')||has(ctx.actions,'rh.editar_funcionarios'));}
function canWriteDocuments(ctx:any){return ctx.userType==='INTERNO'&&(ctx.admin||has(ctx.actions,'rh.editar_funcionarios'));}
function safePart(value:string,fallback:string){const clean=String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9._-]+/g,'_').replace(/^\.+|\.+$/g,'').slice(0,100);return clean||fallback;}
function validVacationPath(value:string){return /^ferias\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)&&!value.includes('..');}
function validStaffPath(value:string){return /^(curriculos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|funcionarios\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/.test(value)&&!value.includes('..');}
function storedPath(value:unknown){const v=String(value||'');return v.startsWith('supabase:')?v.slice(9):v;}
function fileMeta(file:File){if(!file.size||file.size>MAX_FILE_SIZE)throw new Error('ARQUIVO_INVALIDO');const ext=safePart((file.name.split('.').pop()||'bin').toLowerCase(),'bin');const mime=ALLOWED_MIME.has(file.type)?file.type:MIME_BY_EXT[ext];if(!mime)throw new Error('FORMATO_INVALIDO');return {ext,mime,baseName:safePart(file.name.replace(/\.[^.]+$/,''),'arquivo')};}
async function row(){const q=await db.from('portal_rh_data').select('id,payload,revision,updated_at,updated_by').eq('id',1).maybeSingle();if(q.error)throw q.error;return q.data||{id:null,payload:{},revision:0,updated_at:null,updated_by:null};}
function isEmployeeAccess(f:any){return String(f?.perfilRh||'').toUpperCase()==='FUNCIONARIO'&&!!email(f?.loginEmail);}
function linkedEmployee(payload:any,ctx:any,required=true){const matches=(payload?.funcionarios||[]).filter((f:any)=>isEmployeeAccess(f)&&email(f.loginEmail)===ctx.me.email);if(matches.length>1)throw new Error('VINCULO_DUPLICADO');if(matches.length===1)return matches[0];if(!required)return null;throw new Error('FUNCIONARIO_NAO_VINCULADO');}
function isPayslip(d:any){return /holerite|contracheque|recibo de pagamento/i.test(String(d?.categoria||d?.tipo||d?.titulo||''));}
function employeePayload(payload:any,f:any){
  const docs=(Array.isArray(f.documentos)?f.documentos:[]).map((d:any)=>({id:d.id||null,tipo:d.tipo||d.categoria||'Documento',categoria:d.categoria||d.tipo||'Outros',titulo:d.titulo||null,nome:d.nome||null,emissao:d.emissao||null,validade:d.validade||null,competencia:d.competencia||null,status:d.status||'Disponível',observacoes:d.observacoes||null,arquivo:d.arquivo||null,storage:d.storage||null,adicionadoEm:d.adicionadoEm||null,origem:d.origem||'RH'}));
  const holerites=[...docs.filter(isPayslip),...(Array.isArray(payload.holerites)?payload.holerites.filter((h:any)=>String(h.funcionarioId)===String(f.id)):[])];
  const own={id:f.id,nome:f.nome,status:f.status,empresa:f.empresa,cargo:f.cargo,nivel:f.nivel,departamento:f.departamento||null,tipoVinculo:f.tipoVinculo||null,dataAdmissao:f.dataAdmissao||null,dataDemissao:f.dataDemissao||null,linkedin:f.linkedin||null,foto:f.foto||null,curriculo:f.curriculo||null,pessoal:structuredClone(f.pessoal||{}),documentos:docs,projetos:structuredClone(f.projetos||[])};
  return {meta:{...(payload.meta||{}),employeePortal:true},funcionarios:[own],ferias:(payload.ferias||[]).filter((r:any)=>String(r.funcionarioId)===String(f.id)),holerites,projetos:[],clientes:[],cargos:[],regrasSalario:[],empresas:[]};
}
function employeeReferences(payload:any,f:any){const refs=new Set<string>();const add=(v:any)=>{const p=storedPath(v);if(validStaffPath(p))refs.add(p);};add(f.curriculo);add(f.foto);for(const d of (f.documentos||[]))add(d?.arquivo);for(const h of (payload.holerites||[]))if(String(h.funcionarioId)===String(f.id))add(h?.arquivo);return refs;}
function vacationReferences(payload:any,f:any){const refs=new Set<string>();const add=(v:any)=>{const p=storedPath(v);if(validVacationPath(p))refs.add(p);};for(const r of (payload.ferias||[])){if(String(r.funcionarioId)!==String(f.id))continue;add(r?.comprovante?.arquivo);for(const p of (r.opcoesFuncionario||[]))for(const a of (p.anexos||[]))add(a?.arquivo);}return refs;}
function sanitize(payload:any,ctx:any){const x=structuredClone(payload||{});const salary=has(ctx.actions,'rh.visualizar_salarios');const bank=has(ctx.actions,'rh.visualizar_dados_bancarios');const sensitive=has(ctx.actions,'rh.visualizar_dados_sensiveis');const docs=ctx.userType==='INTERNO'&&has(ctx.actions,'rh.visualizar_documentos');if(Array.isArray(x.cargos)&&!salary)x.cargos=x.cargos.map((c:any)=>({...c,salario:null}));if(Array.isArray(x.regrasSalario)&&!salary)x.regrasSalario=x.regrasSalario.map((r:any)=>({...r,salario:null}));if(Array.isArray(x.funcionarios)){x.funcionarios=x.funcionarios.map((f:any)=>{const n={...f};if(!bank)n.bancos=[];if(!docs){n.documentos=[];n.foto=null;n.curriculo=null;}if(!sensitive){const p={...(n.pessoal||{})};['cpf','rg','cnh','pis','tituloEleitor','nascimento','endereco','estadoCivil','tipoSanguineo','emergenciaNome','emergenciaTelefone','emergenciaParentesco','emergencias','dependentes','saude','qualDoenca','quaisMedicamentos','tiposAlergias'].forEach(k=>{if(k in p)p[k]=null;});n.pessoal=p;n.observacoes=null;n.avaliacao=null;}return n;});}return x;}
async function audit(actor:string,action:string,target:string,detail:any={}){await db.from('access_audit').insert({actor_email:actor,action,target,detail});}

Deno.serve(async(req)=>{
  const origin=req.headers.get('origin');
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors(origin)});
  try{
    const url=new URL(req.url),base='/rh-api',i=url.pathname.indexOf(base),path=i>=0?url.pathname.slice(i+base.length)||'/':'/';
    if(path==='/health'&&req.method==='GET')return reply(origin,200,{ok:true,service:'rh-api',version:20});
    const ctx=await rhAccess(req);
    if(ctx.userType!=='INTERNO')throw new Error('FORBIDDEN');

    if(path==='/vacation-files'&&req.method==='POST'){
      const current=await row();if((!ctx.admin&&linkedEmployee(current.payload,ctx,false))||!canWriteDocuments(ctx))throw new Error('FORBIDDEN');
      const form=await req.formData(),file=form.get('file'),vacationId=safePart(String(form.get('vacationId')||''),'sem-registro'),period=Number(form.get('period')||0);
      if(!(file instanceof File))return reply(origin,400,{error:'Arquivo inválido'});if(!Number.isInteger(period)||period<1||period>3)return reply(origin,400,{error:'Período de férias inválido'});
      const {ext,mime,baseName}=fileMeta(file),objectPath=`ferias/${vacationId}/${crypto.randomUUID()}_p${period}_${baseName}.${ext}`;
      const up=await db.storage.from(VACATION_BUCKET).upload(objectPath,file,{contentType:mime,upsert:false,cacheControl:'3600'});if(up.error)throw up.error;
      await audit(ctx.me.email,'RH_VACATION_FILE_UPLOAD',objectPath,{vacationId,period,size:file.size,mime});
      return reply(origin,201,{ok:true,file:{id:crypto.randomUUID(),nome:file.name,arquivo:objectPath,storage:'supabase',tipo:mime,tamanho:file.size,adicionadoEm:new Date().toISOString()}});
    }
    if(path==='/vacation-files'&&req.method==='GET'){
      const objectPath=String(url.searchParams.get('path')||'');if(!validVacationPath(objectPath))return reply(origin,400,{error:'Caminho de arquivo inválido'});
      const current=await row(),f=!ctx.admin?linkedEmployee(current.payload,ctx,false):null;if(f){if(!vacationReferences(current.payload,f).has(objectPath))throw new Error('FORBIDDEN');}else if(!canReadDocuments(ctx))throw new Error('FORBIDDEN');
      const signed=await db.storage.from(VACATION_BUCKET).createSignedUrl(objectPath,120,{download:url.searchParams.get('download')==='1'});if(signed.error)throw signed.error;
      await audit(ctx.me.email,'RH_VACATION_FILE_OPEN',objectPath);return reply(origin,200,{ok:true,url:signed.data.signedUrl,expiresIn:120});
    }
    if(path==='/vacation-files'&&req.method==='DELETE'){
      const current=await row();if((!ctx.admin&&linkedEmployee(current.payload,ctx,false))||!canWriteDocuments(ctx))throw new Error('FORBIDDEN');const objectPath=String(url.searchParams.get('path')||'');if(!validVacationPath(objectPath))return reply(origin,400,{error:'Caminho de arquivo inválido'});
      const removed=await db.storage.from(VACATION_BUCKET).remove([objectPath]);if(removed.error)throw removed.error;await audit(ctx.me.email,'RH_VACATION_FILE_DELETE',objectPath);return reply(origin,200,{ok:true});
    }

    if(path==='/staff-files'&&req.method==='POST'){
      const current=await row();if((!ctx.admin&&linkedEmployee(current.payload,ctx,false))||!canWriteDocuments(ctx))throw new Error('FORBIDDEN');const form=await req.formData(),file=form.get('file'),employeeId=safePart(String(form.get('employeeId')||''),'sem-cadastro'),category=safePart(String(form.get('category')||'curriculos'),'curriculos');
      if(!(file instanceof File))return reply(origin,400,{error:'Arquivo inválido'});const {ext,mime,baseName}=fileMeta(file);const objectPath=category==='curriculos'?`curriculos/${employeeId}/${crypto.randomUUID()}_${baseName}.${ext}`:`funcionarios/${employeeId}/${category}/${crypto.randomUUID()}_${baseName}.${ext}`;
      const up=await db.storage.from(STAFF_BUCKET).upload(objectPath,file,{contentType:mime,upsert:false,cacheControl:'3600'});if(up.error)throw up.error;await audit(ctx.me.email,'RH_STAFF_FILE_UPLOAD',objectPath,{employeeId,category,size:file.size,mime});
      return reply(origin,201,{ok:true,file:{nome:file.name,arquivo:objectPath,storage:'supabase',tipo:mime,tamanho:file.size,adicionadoEm:new Date().toISOString()}});
    }

    if(path==='/payslip-files'&&req.method==='POST'){
      const first=await row();if((!ctx.admin&&linkedEmployee(first.payload,ctx,false))||!canWriteDocuments(ctx))throw new Error('FORBIDDEN');
      const form=await req.formData(),file=form.get('file'),employeeId=String(form.get('employeeId')||''),expectedName=String(form.get('employeeName')||''),titulo=String(form.get('titulo')||'').trim(),observacoes=String(form.get('observacoes')||'').trim();
      if(!(file instanceof File)||!titulo||titulo.length>160||observacoes.length>4000)return reply(origin,400,{error:'Informe arquivo e nome de exibição de até 160 caracteres.'});
      const {ext}=fileMeta(file);if(ext!=='pdf')return reply(origin,400,{error:'A importação de holerites aceita somente PDF.'});
      const norm=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toUpperCase();
      const targetFor=(current:any)=>{const matches=(current.payload.funcionarios||[]).filter((f:any)=>String(f.id)===employeeId);if(matches.length!==1)throw new Error('FUNCIONARIO_INVALIDO');const f=matches[0];if(!expectedName||norm(f.nome)!==norm(expectedName)||!norm(file.name.replace(/\.pdf$/i,'')).endsWith(' - '+norm(f.nome)))throw new Error('FUNCIONARIO_INVALIDO');return f;};
      const f=targetFor(first),bytes=await file.arrayBuffer();if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')return reply(origin,400,{error:'O arquivo não é um PDF válido.'});
      const sourceSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');
      const duplicate=(employee:any)=>(employee.documentos||[]).find((d:any)=>d.sourceSha256===sourceSha256);
      const existing=duplicate(f);if(existing)return reply(origin,200,{ok:true,skipped:true,file:existing,employeeId,revision:first.revision});
      const objectPath='funcionarios/'+safePart(employeeId,'funcionario')+'/holerites/'+crypto.randomUUID()+'.pdf',up=await db.storage.from(STAFF_BUCKET).upload(objectPath,file,{contentType:'application/pdf',upsert:false,cacheControl:'3600'});if(up.error)throw up.error;
      const rec={id:crypto.randomUUID(),tipo:'Holerite',categoria:'Holerite',titulo,nome:file.name,competencia:/^\d{4}-(0[1-9]|1[0-2])(?:\s|$)/.test(titulo)?titulo.slice(0,7):null,observacoes:observacoes||null,arquivo:'supabase:'+objectPath,storage:'supabase',status:'Disponível',origem:'RH',tamanho:file.size,sourceSha256,adicionadoEm:new Date().toISOString()};
      let committed=false;
      try{
        for(let attempt=0;attempt<4;attempt++){
          const current=attempt===0?first:await row();if(!ctx.admin&&linkedEmployee(current.payload,ctx,false))throw new Error('FORBIDDEN');const target=targetFor(current),found=duplicate(target);if(found)return reply(origin,200,{ok:true,skipped:true,file:found,employeeId,revision:current.revision});
          const payload=structuredClone(current.payload),dest=(payload.funcionarios||[]).find((x:any)=>String(x.id)===employeeId);dest.documentos=Array.isArray(dest.documentos)?dest.documentos:[];dest.documentos.push(rec);
          const saved=await db.from('portal_rh_data').update({payload,revision:current.revision+1,updated_at:new Date().toISOString(),updated_by:ctx.me.email}).eq('id',1).eq('revision',current.revision).select('revision').maybeSingle();if(saved.error)throw saved.error;if(!saved.data)continue;
          committed=true;await audit(ctx.me.email,'RH_PAYSLIP_IMPORT',objectPath,{employeeId,sourceSha256});return reply(origin,201,{ok:true,skipped:false,file:rec,employeeId,revision:current.revision+1});
        }
        return reply(origin,409,{error:'A base foi alterada durante a importação. Repita a seleção; arquivos já cadastrados serão ignorados.'});
      }finally{if(!committed)await db.storage.from(STAFF_BUCKET).remove([objectPath]);}
    }

    if(path==='/employee-files'&&req.method==='POST'){
      const current=await row(),f=linkedEmployee(current.payload,ctx),form=await req.formData(),file=form.get('file');if(!(file instanceof File))return reply(origin,400,{error:'Arquivo inválido'});const {ext,mime,baseName}=fileMeta(file),tipo=String(form.get('tipo')||'Documento enviado').trim().slice(0,80)||'Documento enviado';
      const objectPath=`funcionarios/${safePart(String(f.id),'funcionario')}/enviados/${crypto.randomUUID()}_${baseName}.${ext}`,uploaded=await db.storage.from(STAFF_BUCKET).upload(objectPath,file,{contentType:mime,upsert:false,cacheControl:'3600'});if(uploaded.error)throw uploaded.error;
      const rec={id:crypto.randomUUID(),tipo,categoria:tipo,titulo:String(form.get('titulo')||'').trim().slice(0,160)||null,observacoes:String(form.get('observacoes')||'').trim().slice(0,4000)||null,nome:file.name,arquivo:'supabase:'+objectPath,storage:'supabase',status:'Enviado',origem:'FUNCIONARIO',somenteAdicionar:true,tamanho:file.size,adicionadoEm:new Date().toISOString()};
      const payload=structuredClone(current.payload),target=(payload.funcionarios||[]).find((x:any)=>String(x.id)===String(f.id));target.documentos=Array.isArray(target.documentos)?target.documentos:[];target.documentos.push(rec);const next=current.revision+1;
      const saved=await db.from('portal_rh_data').update({payload,revision:next,updated_at:new Date().toISOString(),updated_by:ctx.me.email}).eq('id',1).eq('revision',current.revision).select('revision').maybeSingle();
      if(saved.error||!saved.data){await db.storage.from(STAFF_BUCKET).remove([objectPath]);if(saved.error)throw saved.error;return reply(origin,409,{error:'A base foi alterada. Recarregue e tente novamente.'});}
      await audit(ctx.me.email,'RH_EMPLOYEE_FILE_UPLOAD',objectPath,{employeeId:f.id,size:file.size,mime});return reply(origin,201,{ok:true,file:rec,revision:next});
    }
    if(path==='/staff-files'&&req.method==='GET'){
      const objectPath=String(url.searchParams.get('path')||'');if(!validStaffPath(objectPath))return reply(origin,400,{error:'Caminho de arquivo inválido'});
      const current=await row(),f=!ctx.admin?linkedEmployee(current.payload,ctx,false):null;if(f){if(!employeeReferences(current.payload,f).has(objectPath))throw new Error('FORBIDDEN');}else if(!canReadDocuments(ctx))throw new Error('FORBIDDEN');
      const signed=await db.storage.from(STAFF_BUCKET).createSignedUrl(objectPath,120,{download:url.searchParams.get('download')==='1'});if(signed.error)throw signed.error;await audit(ctx.me.email,'RH_STAFF_FILE_OPEN',objectPath);return reply(origin,200,{ok:true,url:signed.data.signedUrl,expiresIn:120});
    }
    if(path==='/staff-files'&&req.method==='DELETE'){
      const current=await row();if((!ctx.admin&&linkedEmployee(current.payload,ctx,false))||!canWriteDocuments(ctx))throw new Error('FORBIDDEN');const objectPath=String(url.searchParams.get('path')||'');if(!validStaffPath(objectPath))return reply(origin,400,{error:'Caminho de arquivo inválido'});const removed=await db.storage.from(STAFF_BUCKET).remove([objectPath]);if(removed.error)throw removed.error;await audit(ctx.me.email,'RH_STAFF_FILE_DELETE',objectPath);return reply(origin,200,{ok:true});
    }

    if(path==='/data'&&req.method==='GET'){
      const current=await row(),f=ctx.admin?null:linkedEmployee(current.payload,ctx,false);
      if(f){const data=employeePayload(current.payload,f);return reply(origin,200,{ok:true,empty:false,revision:current.revision,updatedAt:current.updated_at,updatedBy:current.updated_by,data,userType:ctx.userType,user:ctx.me,employeeOnly:true,employeeId:f.id,permissions:{salary:false,bank:false,sensitive:true,documents:true,edit:false,upload:true}});}
      if(!ctx.admin&&!has(ctx.actions,'rh.visualizar_dados_basicos'))throw new Error('FUNCIONARIO_NAO_VINCULADO');
      const empty=!current.payload||Object.keys(current.payload).length===0;return reply(origin,200,{ok:true,empty,revision:current.revision,updatedAt:current.updated_at,updatedBy:current.updated_by,data:empty?{}:sanitize(current.payload,ctx),userType:ctx.userType,user:ctx.me,employeeOnly:false,permissions:{salary:has(ctx.actions,'rh.visualizar_salarios'),bank:has(ctx.actions,'rh.visualizar_dados_bancarios'),sensitive:has(ctx.actions,'rh.visualizar_dados_sensiveis'),documents:ctx.userType==='INTERNO'&&has(ctx.actions,'rh.visualizar_documentos'),edit:has(ctx.actions,'rh.editar_funcionarios')}});
    }
    if(path==='/data'&&req.method==='PUT'){
      if(ctx.userType!=='INTERNO'||!has(ctx.actions,'rh.editar_funcionarios'))throw new Error('FORBIDDEN');
      const body=await req.json();if(!body?.data||typeof body.data!=='object'||Array.isArray(body.data))return reply(origin,400,{error:'Dados inválidos'});if(!Number.isSafeInteger(body.revision)||body.revision<0)return reply(origin,428,{error:'Revisão obrigatória. Recarregue os dados.'});
      const current=await row();if(!ctx.admin&&linkedEmployee(current.payload,ctx,false))throw new Error('FORBIDDEN');if(current.revision!==body.revision)return reply(origin,409,{error:'A base foi alterada. Recarregue antes de salvar.'});
      const incoming=structuredClone(body.data),safe=['id','nome','status','empresa','cargo','nivel','departamento','tipoVinculo','linkedin','dataAdmissao','dataDemissao','pasta','loginEmail','perfilRh'];
      if(ctx.admin||has(ctx.actions,'rh.visualizar_documentos'))safe.push('foto','curriculo','documentos');if(ctx.admin||has(ctx.actions,'rh.visualizar_dados_sensiveis'))safe.push('pessoal','avaliacao','obsAvaliacao','motivosObs','observacoes');if(ctx.admin||has(ctx.actions,'rh.visualizar_dados_bancarios'))safe.push('bancos');
      const byId=new Map((current.payload.funcionarios||[]).map((f:any)=>[String(f.id),f]));const funcionarios=(incoming.funcionarios||[]).map((f:any)=>{const old=byId.get(String(f.id));if(!old)return {...f,pessoal:f.pessoal||{},bancos:f.bancos||[],documentos:f.documentos||[],projetos:f.projetos||[]};const n={...old};safe.forEach(k=>{if(k in f)n[k]=f[k];});return n;});
      const linked=new Map<string,string>();for(const f of funcionarios){if(!isEmployeeAccess(f))continue;const e=email(f.loginEmail);if(!/^\S+@\S+\.\S+$/.test(e))return reply(origin,400,{error:`E-mail de acesso inválido em ${f.nome||f.id}`});if(linked.has(e))return reply(origin,409,{error:'O mesmo e-mail de acesso está vinculado a mais de um funcionário.'});linked.set(e,String(f.id));}
      const payload={...current.payload,...incoming,funcionarios,cargos:current.payload.cargos||[],regrasSalario:current.payload.regrasSalario||[],projetos:current.payload.projetos||[],clientes:current.payload.clientes||[]},next=body.revision+1;
      const saved=await db.from('portal_rh_data').update({payload,revision:next,updated_at:new Date().toISOString(),updated_by:ctx.me.email}).eq('id',1).eq('revision',body.revision).select('revision').maybeSingle();if(saved.error)throw saved.error;if(!saved.data)return reply(origin,409,{error:'A base foi alterada. Recarregue antes de salvar.'});await audit(ctx.me.email,'RH_DATA_SAVE','RH',{revision:next});return reply(origin,200,{ok:true,revision:next});
    }
    if(path==='/bootstrap'&&req.method==='POST'){
      if(!ctx.admin)throw new Error('FORBIDDEN');const body=await req.json();if(!body?.data||typeof body.data!=='object'||Array.isArray(body.data)||Object.keys(body.data).length===0)return reply(origin,400,{error:'Dados inválidos'});if(body.force)return reply(origin,409,{error:'Substituição forçada não permitida'});const current=await row();if(current.payload&&Object.keys(current.payload).length>0)return reply(origin,409,{error:'Base RH já inicializada'});const next=(current.revision||0)+1,values={payload:body.data,revision:next,updated_at:new Date().toISOString(),updated_by:ctx.me.email};let saved;if(current.id)saved=await db.from('portal_rh_data').update(values).eq('id',1).eq('revision',current.revision).eq('payload','{}').select('revision').maybeSingle();else saved=await db.from('portal_rh_data').insert({id:1,...values}).select('revision').maybeSingle();if(saved.error?.code==='23505'||(!saved.error&&!saved.data))return reply(origin,409,{error:'Base RH já inicializada'});if(saved.error)throw saved.error;await audit(ctx.me.email,'RH_DATA_BOOTSTRAP','RH',{revision:next});return reply(origin,200,{ok:true,revision:next});
    }
    return reply(origin,404,{error:'NOT_FOUND'});
  }catch(e){const m=e instanceof Error?e.message:'ERROR';const status=e instanceof SyntaxError?400:m==='UNAUTHENTICATED'?401:['FORBIDDEN','FUNCIONARIO_NAO_VINCULADO'].includes(m)?403:m==='VINCULO_DUPLICADO'?409:m==='FUNCIONARIO_INVALIDO'?400:['ARQUIVO_INVALIDO','FORMATO_INVALIDO'].includes(m)?400:500;const friendly=m==='FUNCIONARIO_INVALIDO'?'O arquivo e o cadastro devem corresponder ao mesmo funcionário.':m==='FUNCIONARIO_NAO_VINCULADO'?'Seu acesso individual ao RH ainda não foi vinculado pelo administrador.':m==='ARQUIVO_INVALIDO'?'Arquivo inválido ou maior que 10 MB.':m==='FORMATO_INVALIDO'?'Formato não permitido. Use PDF, imagem, DOC ou DOCX.':m;return reply(origin,status,{error:friendly});}
});
