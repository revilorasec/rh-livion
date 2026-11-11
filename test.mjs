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
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');for(const marker of ['const APP_VER = "1.19.1"','Área individual: você está vendo somente seus próprios dados.','employee-home','employee-data','employee-vacations','employee-documents','employee-payslips','Funcionário — vê somente os próprios dados','E-mail exato para entrar no RH','Holerite','/employee-files'])assert.ok(html.includes(marker),marker);for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(match[1].trim())new vm.Script(match[1]);
});

function payslipUI({doc=null,save=true}={}){
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const f={id:'F1',documentos:doc?[structuredClone(doc)]:[]};
  const state={f,uploads:[],messages:[],saves:0,fields:null,values:null,onSave:null};
  const controls={};for(const key of ['tipo','competencia','emissao','validade']){const row={hidden:false};controls[key]={value:key==='tipo'?(doc?.tipo||'RG'):'',closest:()=>row,addEventListener(_event,fn){this.change=fn;}};}
  const ctx={A:{},DB:{funcionarios:[f],holerites:[]},getF:()=>f,uid:()=> 'NEW',busy:()=>{},toast:m=>state.messages.push(m),saveDB:async()=>{state.saves++;return save;},uploadStaffFile:async(file,id,category)=>{state.uploads.push({file,id,category});return {arquivo:'funcionarios/F1/holerites/new.pdf',nome:file.name};},openForm(_title,fields,values,onSave){Object.assign(state,{fields,values,onSave});return {querySelector:selector=>controls[selector.slice(4)]};},esc:s=>String(s??'').replaceAll('<','&lt;'),fmtDate:v=>v,employeeFileActions:()=>'',employeeScope:()=>''};
  vm.createContext(ctx);
  for(const name of ['employeePayslip','payslipMonth','payslipTitle','employeePayslips','employeeDocRow','vEmployeePayslips'])vm.runInContext(html.split(/\r?\n/).find(line=>line.startsWith('function '+name+'(')),ctx);
  const start=html.indexOf('const TIPOS_DOC ='),end=html.indexOf('A.delDoc',start);vm.runInContext(html.slice(start,end),ctx);
  ctx.A.editDoc('F1',doc?0:-1);return {ctx,state,controls};
}

test('holerite exige referência válida e arquivo; grava mês sem depender da emissão',async()=>{
  const {state,controls}=payslipUI();controls.tipo.value='Holerite';controls.tipo.change();
  assert.equal(controls.competencia.closest().hidden,false);assert.equal(controls.emissao.closest().hidden,true);assert.equal(controls.validade.closest().hidden,true);
  const v={tipo:'Holerite',competencia:'2026-13',observacoes:'Referente a outubro'};
  assert.equal(await state.onSave(v),false);assert.equal(state.uploads.length,0);
  v.competencia='2026-10';assert.equal(await state.onSave(v),false);assert.equal(state.saves,0);
  v._file={name:'arquivo.pdf',size:100};await state.onSave(v);
  assert.equal(state.f.documentos[0].competencia,'2026-10');assert.equal(state.f.documentos[0].emissao,null);assert.equal(state.f.documentos[0].observacoes,v.observacoes);assert.equal(state.uploads[0].category,'holerites');
});

test('edição de referência mantém arquivo existente e falha ao salvar preserva o registro',async()=>{
  const doc={id:'D1',tipo:'Holerite',competencia:'2026-11',arquivo:'supabase:old.pdf',emissao:'2026-12-05',observacoes:'Original'};
  const {state}=payslipUI({doc});await state.onSave({tipo:'Holerite',competencia:'2026-10',observacoes:'Corrigido'});assert.equal(state.f.documentos[0].arquivo,doc.arquivo);assert.equal(state.uploads.length,0);assert.equal(state.f.documentos[0].emissao,doc.emissao);
  const failed=payslipUI({doc,save:false});assert.equal(await failed.state.onSave({tipo:'Holerite',competencia:'2026-10'}),false);assert.equal(failed.state.f.documentos[0].competencia,'2026-11');
});

test('documentos comuns continuam com emissão e validade sem referência obrigatória',async()=>{
  const {state,controls}=payslipUI();assert.equal(controls.competencia.closest().hidden,true);assert.equal(controls.emissao.closest().hidden,false);
  await state.onSave({tipo:'RG',emissao:'2026-01-02',validade:'2030-01-02',observacoes:'RG'});assert.equal(state.f.documentos[0].emissao,'2026-01-02');assert.equal(state.f.documentos[0].validade,'2030-01-02');
});

test('lista destaca referência, ordena entre anos e não inventa mês para legado',()=>{
  const {ctx,state}=payslipUI();state.f.documentos=[{id:'old',tipo:'Holerite',emissao:'2026-11-01'},{id:'oct',tipo:'Holerite',competencia:'2026-10',observacoes:'<Observação>'},{id:'jan',tipo:'Holerite',competencia:'2027-01'},{id:'nov',tipo:'Holerite',competencia:'2026-11'}];
  const html=ctx.vEmployeePayslips();assert.ok(html.indexOf('Janeiro de 2027')<html.indexOf('Novembro de 2026'));assert.ok(html.indexOf('Novembro de 2026')<html.indexOf('Outubro de 2026'));assert.ok(html.indexOf('Outubro de 2026')<html.indexOf('Holerite — Referência não informada'));assert.ok(html.includes('&lt;Observação>'));assert.ok(!html.includes('Competência 2026-10'));
});
