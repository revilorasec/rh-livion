import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = readFileSync(new URL('./supabase/functions/rh-api/index.ts', import.meta.url), 'utf8');
const code = stripTypeScriptTypes(source.replace(/^import .*\n/, ''));
const required = ['rh.visualizar_dados_basicos','rh.editar_funcionarios','rh.visualizar_salarios','rh.visualizar_dados_bancarios','rh.visualizar_dados_sensiveis','rh.visualizar_documentos'];
function fixture({ actions = required, admin = false, row = { id:1, revision:3, payload:{ funcionarios:[] } }, active = true, userType='INTERNO' } = {}) {
  let handler;
  const state = { row:structuredClone(row), writes:0 };
  const db = { from(table) {
    let op='read', values, filters=[];
    const q = {
      select(){return q;}, eq(k,v){filters.push([k,k==='payload'&&typeof v==='string'?JSON.parse(v):v]);return q;},
      update(v){op='update';values=v;return q;},
      insert(v){op='insert';values=v;return q;},
      async maybeSingle(){
        if(table==='portal_users') return {data:{active,profile:admin?'ADMINISTRADOR':'USUARIO',apps:['rh'],actions,user_type:userType}};
        if(op==='read') return {data:structuredClone(state.row)};
        if(op==='insert' && state.row) return {error:{code:'23505'}};
        if(op==='update' && (!state.row || !filters.every(([k,v])=>JSON.stringify(state.row[k])===JSON.stringify(v)))) return {data:null};
        state.row={...state.row,...structuredClone(values)};state.writes++;
        return {data:{revision:state.row.revision}};
      },
    };
    return q;
  }};
  vm.runInNewContext(code, {
    createClient:()=>db, Deno:{env:{get:()=>''},serve:fn=>{handler=fn;}},
    Request,Response,URL,structuredClone,atob,console,
    fetch:async()=>Response.json({id:'synthetic',mail:'test@example.invalid'}),
  });
  const token='x.'+Buffer.from(JSON.stringify({tid:'911e1aee-070e-421b-ae71-439f01c2263e',azp:'88cf5cba-9f67-467d-8a51-9638200bed52'})).toString('base64url')+'.x';
  return {state, async call(path='/data', body={data:{funcionarios:[]},revision:3}, method='PUT', authenticated=true){
    return handler(new Request('https://example.invalid/rh-api'+path,{method,headers:authenticated?{Authorization:'Bearer '+token}:{},...(method==='GET'?{}:{body:JSON.stringify(body)})}));
  }};
}
for(const missing of required.slice(1)) test('bloqueia ausência de '+missing,async()=>{
  const f=fixture({actions:required.filter(x=>x!==missing)});
  assert.equal((await f.call()).status,403);assert.equal(f.state.writes,0);
});
test('salva com permissões completas e revisão atual',async()=>{
  const f=fixture();assert.equal((await f.call()).status,200);assert.equal(f.state.row.revision,4);
});
test('revisão antiga preserva a base',async()=>{
  const f=fixture();assert.equal((await f.call('/data',{data:{},revision:2})).status,409);assert.equal(f.state.writes,0);
});
test('duas gravações concorrentes: apenas uma vence',async()=>{
  const f=fixture();const r=await Promise.all([f.call(),f.call()]);assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);assert.equal(f.state.writes,1);
});
test('cliente antigo sem revisão recebe 428',async()=>{
  const f=fixture();assert.equal((await f.call('/data',{data:{}})).status,428);assert.equal(f.state.writes,0);
});
test('payload nulo não apaga a base',async()=>{
  const f=fixture();assert.equal((await f.call('/data',{data:null,revision:3})).status,400);assert.equal(f.state.writes,0);
});
test('bootstrap exige administrador',async()=>{
  const f=fixture();assert.equal((await f.call('/bootstrap',{data:{funcionarios:[]}},'POST')).status,403);assert.equal(f.state.writes,0);
});
test('nem administrador pode forçar substituição',async()=>{
  const f=fixture({admin:true});assert.equal((await f.call('/bootstrap',{data:{funcionarios:[]},force:true},'POST')).status,409);assert.equal(f.state.writes,0);
});
test('base ocupada não pode ser inicializada novamente',async()=>{
  const f=fixture({admin:true});assert.equal((await f.call('/bootstrap',{data:{funcionarios:[]}},'POST')).status,409);assert.equal(f.state.writes,0);
});
for(const row of [null,{id:1,revision:0,payload:{}}]) test('bootstrap concorrente preserva primeiro resultado '+(row?'vazio':'ausente'),async()=>{
  const f=fixture({admin:true,row});const r=await Promise.all([f.call('/bootstrap',{data:{funcionarios:[]}},'POST'),f.call('/bootstrap',{data:{funcionarios:[]}},'POST')]);assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);assert.equal(f.state.writes,1);
});
test('leitura sem permissão documental remove também currículo',async()=>{
  const f=fixture({actions:['rh.visualizar_dados_basicos'],row:{id:1,revision:3,payload:{funcionarios:[{foto:'foto',curriculo:'cv',documentos:[{}],bancos:[{}],pessoal:{cpf:'sintetico'}}]}}});
  const r=await f.call('/data',null,'GET');assert.equal(r.status,200);const data=await r.json();const p=data.data.funcionarios[0];assert.equal(p.curriculo,null);assert.equal(p.foto,null);assert.deepEqual(p.documentos,[]);assert.equal(p.pessoal.cpf,null);
});
test('sem autenticação: 401; usuário inativo: 403',async()=>{
  assert.equal((await fixture().call('/data',{},'PUT',false)).status,401);
  const f=fixture({active:false});assert.equal((await f.call()).status,403);assert.equal(f.state.writes,0);
});
test('HTML candidato mantém baseline exceto controle da revisão e tem JS válido',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  assert.ok(html.includes('const APP_VER = "1.11.0"'));
  for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if(match[1].trim()) new vm.Script(match[1]);
});

test('externo com permissões documentais não recebe arquivos nem grava base',async()=>{
  const f=fixture({userType:'EXTERNO',row:{id:1,revision:3,payload:{funcionarios:[{foto:'a',curriculo:'b',documentos:[{}]}]}}});
  const r=await f.call('/data',null,'GET'),body=await r.json();
  assert.equal(body.permissions.documents,false);assert.equal(body.data.funcionarios[0].curriculo,null);
  assert.equal((await f.call()).status,403);assert.equal(f.state.writes,0);
});

function fileScreen({userType='INTERNO',documents=true,actualId='synthetic'}={}){
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8'),calls=[];
  const account={localAccountId:actualId};
  const c=vm.createContext({
    PORTAL_SESSION:{token:'portal-user-read'},PORTAL_DATA_META:{userType,user:{id:'synthetic',email:'test@example.invalid'},permissions:{documents,edit:true,salary:true,bank:true,sensitive:true}},
    FOLDER:null,SCOPES:['User.Read','Files.ReadWrite.All'],msalApp:{getAllAccounts:()=>[account],acquireTokenSilent:async()=>({accessToken:'files-token'})},
    fetch:async(url)=>{calls.push(url);return Response.json({id:'folder',parentReference:{driveId:'drive'}})},
    cfg:{folder:'00-PORTAL LIVION/RECURSOS HUMANOS'},DEFAULT_FOLDER:'00-PORTAL LIVION/RECURSOS HUMANOS',LIB_MSAL:Promise.resolve(),Response,console,
  });
  vm.runInContext(html.slice(html.indexOf('let graphReady='),html.indexOf('async function loadDB(')),c);
  return {c,calls,run:code=>vm.runInContext(code,c)};
}
test('arquivos: resolve pasta antes de criar caminho e usa token de arquivos',async()=>{
  const f=fileScreen();await f.run('ensureFiles()');assert.equal(f.c.FOLDER.id,'folder');assert.equal(f.calls.length,1);
  await f.run('ensureFiles()');assert.equal(f.calls.length,1);assert.match(f.run('iPath("Funcionarios/test/Fotos/a.jpg")'),/drives\/drive\/items\/folder/);
});
test('arquivos: conta divergente, externo e falta de permissão falham sem Graph',async()=>{
  for(const opts of [{actualId:'other'},{userType:'EXTERNO'},{documents:false}]){
    const f=fileScreen(opts);await assert.rejects(f.run('ensureFiles()'));assert.equal(f.calls.length,0);
  }
});
test('base legada: Graph bloqueia leitura/escrita de dados.json',async()=>{
  const f=fileScreen();await assert.rejects(f.run('gfetch("/dados.json/content",{method:"PUT"})'));assert.equal(f.calls.length,0);
});
test('abertura direta mostra Portal e não inicia base legada',async()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');let shown='';
  const w={};w.self=w;w.top=w;const c=vm.createContext({window:w,gate:x=>{shown=x},legacyBoot:()=>{throw Error('legado chamado')}});
  vm.runInContext(html.slice(html.indexOf('async function boot(){'),html.indexOf('async function legacyBoot(){')),c);
  await vm.runInContext('boot()',c);assert.match(shown,/Abrir Portal Livion/);
});
test('conexão de arquivos é automática e o botão só aparece como fallback',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  assert.match(html,/void autoConnectFiles\(\)/);
  assert.match(html,/filesState!=="ready"/);
  assert.match(html,/Autorizar arquivos/);
});
test('férias: área, campos completos, normalização e exportação estão presentes',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  for(const marker of ['v:"ferias"','function vFerias()','A.editFerias','aquisitivoInicio','concessivoFim','abonoDias','adiantamento13','avisoEm','pagamentoEm','DB.ferias','add("Férias"']) assert.ok(html.includes(marker),marker);
});

// Executa as funções reais do HTML contra o handler real, com banco/Graph simulados.
function screen(api) {
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const extract=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
  const context=vm.createContext({
    PORTAL_SESSION:{token:'synthetic'},PORTAL_DATA_META:null,DB:null,rawSnapshot:null,
    RH_API:'https://example.invalid/rh-api',busy:()=>{},messages:[],
    fetch:async(url,opt)=>api.call(new URL(url).pathname.replace('/rh-api',''),opt.body?JSON.parse(opt.body):null,opt.method||'GET'),
  });
  vm.runInContext('function toast(message){messages.push(message)}',context);
  vm.runInContext(extract('function rhApi(', 'function waitPortalSession('),context);
  vm.runInContext(extract('async function saveDB(', 'async function uploadFile('),context);
  return {context,async load(){await vm.runInContext('(async()=>{PORTAL_DATA_META=await rhApi("/data");DB=PORTAL_DATA_META.data;rawSnapshot=JSON.stringify(DB)})()',context);},save:()=>vm.runInContext('saveDB()',context)};
}
test('integração: leitura, edição e duas gravações sucessivas da tela',async()=>{
  const f=fixture(),ui=screen(f);await ui.load();ui.context.DB.funcionarios.push({id:'synthetic'});
  assert.equal(await ui.save(),true);assert.equal(ui.context.PORTAL_DATA_META.revision,4);
  assert.equal(await ui.save(),true);assert.equal(f.state.row.revision,5);
  assert.equal(f.state.row.payload.funcionarios[0].id,'synthetic');
});
test('integração: conflito mantém edição local e não sobrescreve outro usuário',async()=>{
  const f=fixture(),a=screen(f),b=screen(f);await a.load();await b.load();
  a.context.DB.funcionarios.push({id:'a'});b.context.DB.funcionarios.push({id:'b'});
  assert.equal(await a.save(),true);assert.equal(await b.save(),false);
  assert.equal(b.context.DB.funcionarios[0].id,'b');assert.equal(b.context.PORTAL_DATA_META.revision,3);
  assert.equal(f.state.row.payload.funcionarios[0].id,'a');assert.match(b.context.messages[0],/Recarregue/);
  await b.load();assert.equal(b.context.DB.funcionarios[0].id,'a');assert.equal(await b.save(),true);
});
test('integração: perfil de consulta não dispara gravação',async()=>{
  const f=fixture({actions:['rh.visualizar_dados_basicos']}),ui=screen(f);await ui.load();
  assert.equal(await ui.save(),false);assert.equal(f.state.writes,0);assert.match(ui.context.messages[0],/permissão/);
});

test('integração: bootstrap seguido de edição usa a revisão recém-criada',async()=>{
  const f=fixture({admin:true,row:{id:1,revision:0,payload:{}}}),ui=screen(f);
  await ui.load();
  Object.assign(ui.context,{
    PORTAL_BOOTSTRAP_PENDING:true,RH_DATA_PATH:'Dados/dados.json',RH_LEGACY_DATA_PATH:'dados.json',
    iPath:x=>x,gjson:async()=>({eTag:'synthetic'}),
    gfetch:async()=>Response.json({funcionarios:[]}),normalizeDB:()=>{},console,
  });
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  vm.runInContext(html.slice(html.indexOf('async function loadDB('),html.indexOf('async function saveDB(')),ui.context);
  await vm.runInContext('loadDB()',ui.context);
  assert.equal(ui.context.PORTAL_BOOTSTRAP_PENDING,false);assert.equal(ui.context.PORTAL_DATA_META.revision,1);
  ui.context.DB.funcionarios.push({id:'synthetic'});
  assert.equal(await ui.save(),true);assert.equal(f.state.row.revision,2);
});

