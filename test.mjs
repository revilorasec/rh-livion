import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';

const source=readFileSync(new URL('./supabase/functions/rh-api/index.ts',import.meta.url),'utf8');
const code=stripTypeScriptTypes(source.replace(/^import .*\n/,''));
const tenant='911e1aee-070e-421b-ae71-439f01c2263e',client='88cf5cba-9f67-467d-8a51-9638200bed52';
const token='x.'+Buffer.from(JSON.stringify({tid:tenant,azp:client})).toString('base64url')+'.x';
const basePayload={
  meta:{},empresas:['Livion'],cargos:[{cargo:'Analista',nivel:'1',salario:99999}],regrasSalario:[],projetos:[{id:'P1',nome:'Secreto'}],clientes:[],
  funcionarios:[
    {id:'F1',nome:'Ana Silva',perfilRh:'FUNCIONARIO',loginEmail:'ana@example.invalid',status:'Ativo',empresa:'Livion',cargo:'Analista',nivel:'1',bancos:[{conta:'secreta'}],pessoal:{emailPessoal:'ana@example.invalid',cpf:'111'},documentos:[{id:'D1',tipo:'Holerite',nome:'holerite.pdf',arquivo:'supabase:funcionarios/F1/holerites/own.pdf',storage:'supabase'}],projetos:[]},
    {id:'F2',nome:'Outra Pessoa',perfilRh:'OPERACIONAL',loginEmail:null,status:'Ativo',bancos:[{conta:'outra'}],pessoal:{cpf:'222'},documentos:[{id:'D2',tipo:'Contrato',arquivo:'supabase:funcionarios/F2/documentos/other.pdf',storage:'supabase'}],projetos:[]},
  ],
  ferias:[{id:'V1',funcionarioId:'F1',opcoesFuncionario:[{inicio:'2026-12-01',fim:'2026-12-10',anexos:[{id:'A1',arquivo:'ferias/V1/own.pdf',storage:'supabase'}]}]},{id:'V2',funcionarioId:'F2'}],holerites:[],
};

function fixture({email='ana@example.invalid',admin=false,actions=['*'],payload=basePayload,userType='INTERNO',apps=['rh']}={}){
  let handler;const state={row:{id:1,revision:7,payload:structuredClone(payload),updated_at:null,updated_by:null},writes:0,uploads:[],removes:[],signed:[]};
  const db={
    from(table){let op='read',values=null,filters=[];const q={
      select(){return q;},eq(k,v){filters.push([k,v]);return q;},update(v){op='update';values=v;return q;},insert(v){op='insert';values=v;return q;},
      async maybeSingle(){
        if(table==='portal_users')return {data:{active:true,profile:admin?'ADMINISTRADOR':'USUARIO',apps,actions,user_type:userType}};
        if(table==='access_audit')return {data:null,error:null};
        if(op==='read')return {data:structuredClone(state.row),error:null};
        if(op==='update'&&!filters.every(([k,v])=>state.row[k]===v))return {data:null,error:null};
        if(op==='update'){state.row={...state.row,...structuredClone(values)};state.writes++;return {data:{revision:state.row.revision},error:null};}
        return {data:null,error:null};
      },
    };return q;},
    storage:{from(){return {
      async upload(path,file){state.uploads.push({path,size:file.size});return {data:{path},error:null};},
      async remove(paths){state.removes.push(...paths);return {data:paths,error:null};},
      async createSignedUrl(path,_seconds,opt){state.signed.push({path,opt});return {data:{signedUrl:'https://files.invalid/'+encodeURIComponent(path)},error:null};},
    };}},
  };
  vm.runInNewContext(code,{createClient:()=>db,Deno:{env:{get:()=>''},serve:fn=>{handler=fn;}},Request,Response,URL,FormData,File,Blob,crypto,structuredClone,atob,console,fetch:async()=>Response.json({id:'synthetic',displayName:'Synthetic',mail:email})});
  return {state,async call(path='/data',{method='GET',body=null,authenticated=true}={}){const headers=authenticated?{Authorization:'Bearer '+token}:{};let requestBody;if(body instanceof FormData)requestBody=body;else if(body!=null){headers['Content-Type']='application/json';requestBody=JSON.stringify(body);}return handler(new Request('https://example.invalid/rh-api'+path,{method,headers,body:requestBody}));}};
}

test('vínculo exato retorna somente o próprio funcionário e seus registros',async()=>{
  const f=fixture(),r=await f.call(),b=await r.json();assert.equal(r.status,200);assert.equal(b.employeeOnly,true);assert.equal(b.data.funcionarios.length,1);assert.equal(b.data.funcionarios[0].id,'F1');assert.equal(b.data.funcionarios[0].bancos,undefined);assert.deepEqual(b.data.projetos,[]);assert.equal(b.data.ferias.length,1);assert.equal(b.data.holerites.length,1);
});

test('nome parecido sem perfil e e-mail exatos não cria acesso',async()=>{
  const payload=structuredClone(basePayload);payload.funcionarios[0].perfilRh='OPERACIONAL';payload.funcionarios[0].loginEmail=null;const f=fixture({email:'ana.silva@example.invalid',payload,actions:[]});const r=await f.call();assert.equal(r.status,403);assert.match((await r.json()).error,/ainda não foi vinculado/);
});

test('vínculo duplicado bloqueia a leitura em vez de liberar dados gerais',async()=>{const payload=structuredClone(basePayload);payload.funcionarios[1].perfilRh='FUNCIONARIO';payload.funcionarios[1].loginEmail='ana@example.invalid';const r=await fixture({payload}).call();assert.equal(r.status,409);});

test('funcionário vinculado não grava a base mesmo com ação administrativa residual',async()=>{
  const f=fixture({actions:['*']}),r=await f.call('/data',{method:'PUT',body:{data:basePayload,revision:7}});assert.equal(r.status,403);assert.equal(f.state.writes,0);
});

test('perfil externo continua bloqueado no RH',async()=>{const r=await fixture({userType:'EXTERNO'}).call();assert.equal(r.status,403);});

test('funcionário abre arquivo próprio, mas não arquivo de terceiro',async()=>{
  const own=fixture(),r1=await own.call('/staff-files?path='+encodeURIComponent('funcionarios/F1/holerites/own.pdf'));assert.equal(r1.status,200);assert.equal(own.state.signed[0].path,'funcionarios/F1/holerites/own.pdf');
  const other=fixture(),r2=await other.call('/staff-files?path='+encodeURIComponent('funcionarios/F2/documentos/other.pdf'));assert.equal(r2.status,403);assert.equal(other.state.signed.length,0);
});

test('funcionário anexa documento somente ao próprio cadastro e não pode excluir',async()=>{
  const f=fixture(),form=new FormData();form.append('tipo','Comprovante');form.append('file',new File(['conteudo'],'comprovante.pdf',{type:'application/pdf'}));const up=await f.call('/employee-files',{method:'POST',body:form});assert.equal(up.status,201);assert.equal(f.state.writes,1);assert.equal(f.state.row.payload.funcionarios[0].documentos.length,2);assert.equal(f.state.row.payload.funcionarios[1].documentos.length,1);assert.match(f.state.uploads[0].path,/^funcionarios\/F1\/enviados\//);
  const del=await f.call('/staff-files?path='+encodeURIComponent(f.state.uploads[0].path),{method:'DELETE'});assert.equal(del.status,403);assert.equal(f.state.removes.length,0);
});

test('administrador continua recebendo a base completa',async()=>{const f=fixture({admin:true}),r=await f.call(),b=await r.json();assert.equal(r.status,200);assert.equal(b.employeeOnly,false);assert.equal(b.data.funcionarios.length,2);});

test('backend rejeita e-mail individual duplicado',async()=>{const payload=structuredClone(basePayload);payload.funcionarios[1].perfilRh='FUNCIONARIO';payload.funcionarios[1].loginEmail='ana@example.invalid';const f=fixture({admin:true}),r=await f.call('/data',{method:'PUT',body:{data:payload,revision:7}});assert.equal(r.status,409);assert.equal(f.state.writes,0);});

test('interface individual e configuração administrativa estão presentes e o JavaScript é válido',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');for(const marker of ['const APP_VER = "1.19.0"','Área individual: você está vendo somente seus próprios dados.','employee-home','employee-data','employee-vacations','employee-documents','employee-payslips','Funcionário — vê somente os próprios dados','E-mail exato para entrar no RH','Holerite','/employee-files'])assert.ok(html.includes(marker),marker);for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(match[1].trim())new vm.Script(match[1]);
});
