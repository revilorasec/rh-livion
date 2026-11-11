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

function fixture({email='ana@example.invalid',admin=false,actions=['*'],payload=basePayload,userType='INTERNO',apps=['rh'],conflicts=0,failUpdates=false}={}){
  let handler;const state={row:{id:1,revision:7,payload:structuredClone(payload),updated_at:null,updated_by:null},writes:0,uploads:[],removes:[],signed:[]};
  const db={
    from(table){let op='read',values=null,filters=[];const q={
      select(){return q;},eq(k,v){filters.push([k,v]);return q;},update(v){op='update';values=v;return q;},insert(v){op='insert';values=v;return q;},
      async maybeSingle(){
        if(table==='portal_users')return {data:{active:true,profile:admin?'ADMINISTRADOR':'USUARIO',apps,actions,user_type:userType}};
        if(table==='access_audit')return {data:null,error:null};
        if(op==='read')return {data:structuredClone(state.row),error:null};
        if(op==='update'&&failUpdates)return {data:null,error:{message:'Falha simulada'}};
        if(op==='update'&&conflicts-->0){state.row.revision++;state.row.payload.meta.concurrent='preservado';return {data:null,error:null};}
        if(op==='update'&&!filters.every(([k,v])=>state.row[k]===v))return {data:null,error:null};
        if(op==='update'){state.row={...state.row,...structuredClone(values)};state.writes++;return {data:{revision:state.row.revision},error:null};}
        return {data:null,error:null};
      },
    };return q;},
    storage:{from(){return {
      async upload(path,file){state.uploads.push({path,size:file.size});return {data:{path},error:null};},
      async remove(paths){state.removes.push(...paths);return {data:paths,error:null};},
      async createSignedUploadUrl(path){state.signed.push({path});return {data:{signedUrl:"https://files.invalid/upload/"+path},error:null};},
      async createSignedUrl(path,_seconds,opt){state.signed.push({path,opt});return {data:{signedUrl:'https://files.invalid/'+encodeURIComponent(path)},error:null};},
    };}},
  };
  vm.runInNewContext(code,{createClient:()=>db,Deno:{env:{get:()=>''},serve:fn=>{handler=fn;}},Request,Response,URL,FormData,File,Blob,TextDecoder,crypto,structuredClone,atob,console,fetch:async()=>Response.json({id:'synthetic',displayName:'Synthetic',mail:email})});
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
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');for(const marker of ['const APP_VER = "1.20.1"','Área individual: você está vendo somente seus próprios dados.','employee-home','employee-data','employee-vacations','employee-documents','employee-payslips','Funcionário — vê somente os próprios dados','E-mail exato para entrar no RH','Holerite','/employee-files'])assert.ok(html.includes(marker),marker);for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(match[1].trim())new vm.Script(match[1]);
});


function payslipUI({doc=null,save=true}={}){
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8'),f={id:'F1',nome:'Ana Silva',documentos:doc?[structuredClone(doc)]:[]};
  const state={f,uploads:[],messages:[],saves:0},controls={};for(const key of ['tipo','emissao','validade']){const row={hidden:false};controls[key]={value:key==='tipo'?(doc?.tipo||'RG'):'',closest:()=>row,addEventListener(_event,fn){this.change=fn;}};}
  const ctx={A:{},DB:{funcionarios:[f],holerites:[]},getF:()=>f,uid:()=> 'NEW',busy:()=>{},toast:m=>state.messages.push(m),saveDB:async()=>{state.saves++;return save;},uploadStaffFile:async(file,id,category)=>{state.uploads.push({file,id,category});return {arquivo:'funcionarios/F1/holerites/new.pdf',nome:file.name};},openForm(_title,fields,values,onSave){Object.assign(state,{fields,values,onSave});return {querySelector:selector=>controls[selector.slice(4)]};},esc:s=>String(s??'').replaceAll('<','&lt;'),fmtDate:v=>v,employeeFileActions:()=>'<button>Abrir</button><button>Baixar</button>',employeeScope:()=>''};
  vm.createContext(ctx);for(const name of ['employeePayslip','payslipMonth','payslipTitle','documentTitle','documentFilename','employeePayslips','employeeDocRow','vEmployeePayslips'])vm.runInContext(html.split(/\r?\n/).find(line=>line.startsWith('function '+name+'(')),ctx);
  const start=html.indexOf('const TIPOS_DOC ='),end=html.indexOf('A.delDoc',start);vm.runInContext(html.slice(start,end),ctx);ctx.A.editDoc('F1',doc?0:-1);return {ctx,state,controls};
}

test('formulário usa nome livre obrigatório e arquivo, sem campo de competência',async()=>{
  const {state,controls}=payslipUI();controls.tipo.value='Holerite';controls.tipo.change();assert.equal(controls.emissao.closest().hidden,true);assert.equal(controls.validade.closest().hidden,true);assert.ok(!state.fields.some(f=>f.k==='competencia'));assert.ok(state.fields.find(f=>f.k==='titulo').req);
  assert.equal(await state.onSave({tipo:'Holerite',titulo:'  '}),false);assert.equal(await state.onSave({tipo:'Holerite',titulo:'Recibo especial'}),false);assert.equal(state.saves,0);
  await state.onSave({tipo:'Holerite',titulo:'Recibo especial',_file:{name:'original.pdf',size:100},observacoes:'Texto livre'});const doc=state.f.documentos[0];assert.equal(doc.titulo,'Recibo especial');assert.equal(doc.nome,'original.pdf');assert.equal(doc.competencia,null);assert.equal(doc.observacoes,'Texto livre');
});
test('editar nome mantém arquivo e metadados anteriores; falha preserva registro',async()=>{
  const doc={id:'D1',tipo:'Holerite',competencia:'2026-11',arquivo:'supabase:old.pdf',nome:'original.pdf',emissao:'2026-12-05'};
  const {state}=payslipUI({doc});await state.onSave({tipo:'Holerite',titulo:'2026-11 - 13o salario - adiantamento'});assert.equal(state.f.documentos[0].titulo,'2026-11 - 13o salario - adiantamento');assert.equal(state.f.documentos[0].arquivo,doc.arquivo);assert.equal(state.f.documentos[0].emissao,doc.emissao);assert.equal(state.uploads.length,0);
  const failed=payslipUI({doc,save:false});assert.equal(await failed.state.onSave({tipo:'Holerite',titulo:'Novo nome'}),false);assert.equal(failed.state.f.documentos[0].titulo,undefined);
});
test('lista mantém título exato, extensão, observação e ações; preserva legado',()=>{
  const {ctx,state}=payslipUI();state.f.documentos=[{id:'old',tipo:'Holerite',competencia:'2026-11'},{id:'oct',tipo:'Holerite',titulo:'2026-10 - 13o salario - integral',nome:'2026-10 - 13o salario - integral - ANA SILVA.pdf',observacoes:'<Observação>'},{id:'jan',tipo:'Holerite',titulo:'2027-01 - Holerite'},{id:'free',tipo:'Holerite',titulo:'Recibo especial'}];
  const html=ctx.vEmployeePayslips();assert.ok(html.includes('<b>2026-10 - 13o salario - integral</b>'));assert.ok(html.includes('2026-10 - 13o salario - integral - ANA SILVA.pdf'));assert.ok(html.includes('&lt;Observação>'));assert.ok(html.includes('Abrir'));assert.ok(html.includes('Baixar'));assert.ok(html.includes('Holerite — Novembro de 2026'));assert.ok(html.indexOf('2027-01 - Holerite')<html.indexOf('2026-10 - 13o salario - integral'));assert.ok(html.includes('Recibo especial'));
});
test('importação remove somente o nome do funcionário e preserva 13º e versões',()=>{
  const {ctx}=payslipUI();for(const title of ['2025-09 - Holerite','2025-11 - 13o salario - adiantamento','2025-12 - 13o salario - integral','2025-10 - Holerite - Retificado'])assert.equal(ctx.payrollImportItem({name:title+' - ANA SILVA.pdf',size:100},{nome:'Ana Silva'}).titulo,title);
  assert.equal(ctx.payrollImportItem({name:'2025-09 - Holerite - ALESSANDRA MARIA VENANCIO GONCALVES.pdf',size:100},{nome:'Alessandra Maria Venâncio Gonçalves'}).titulo,'2025-09 - Holerite');
  assert.throws(()=>ctx.payrollImportItem({name:'2025-09 - Holerite - OUTRA PESSOA.pdf',size:100},{nome:'Ana Silva'}),/não corresponde/);
});

function importForm({name='Ana Silva',id='F1',filename='2025-11 - Holerite - ANA SILVA.pdf',title='2025-11 - Holerite',content='%PDF-1.4 synthetic'}={}){const f=new FormData();f.append('employeeId',id);f.append('employeeName',name);f.append('titulo',title);f.append('file',new File([content],filename,{type:'application/pdf'}));return f;}
test('API importa apenas ao destino conferido e repetição não duplica arquivo',async()=>{
  const f=fixture({admin:true});let r=await f.call('/payslip-files',{method:'POST',body:importForm()});assert.equal(r.status,201);let b=await r.json();assert.equal(b.file.titulo,'2025-11 - Holerite');assert.equal(b.file.nome,'2025-11 - Holerite - ANA SILVA.pdf');assert.equal(b.file.competencia,'2025-11');assert.equal(f.state.row.payload.funcionarios[0].documentos.length,2);assert.equal(f.state.row.payload.funcionarios[1].documentos.length,1);
  r=await f.call('/payslip-files',{method:'POST',body:importForm()});assert.equal(r.status,200);assert.equal((await r.json()).skipped,true);assert.equal(f.state.uploads.length,1);assert.equal(f.state.writes,1);
  const own=fixture({payload:f.state.row.payload});const data=await (await own.call()).json();assert.equal(data.data.funcionarios[0].documentos[1].titulo,'2025-11 - Holerite');assert.equal(data.data.funcionarios.length,1);
});
test('API bloqueia funcionário, nome de terceiro, PDF inválido e cadastro inexistente',async()=>{
  let f=fixture(),r=await f.call('/payslip-files',{method:'POST',body:importForm()});assert.equal(r.status,403);assert.equal(f.state.uploads.length,0);
  for(const args of [{name:'Outra Pessoa'},{id:'missing'},{filename:'2025-11 - Holerite - OUTRA PESSOA.pdf'},{content:'nao e PDF'}]){f=fixture({admin:true});r=await f.call('/payslip-files',{method:'POST',body:importForm(args)});assert.equal(r.status,400);assert.equal(f.state.uploads.length,0);}
});
test('importação preserva gravação concorrente e remove apenas upload não registrado em falha',async()=>{
  const f=fixture({admin:true,conflicts:1}),r=await f.call('/payslip-files',{method:'POST',body:importForm()});assert.equal(r.status,201);assert.equal(f.state.row.payload.meta.concurrent,'preservado');assert.equal(f.state.uploads.length,1);assert.equal(f.state.removes.length,0);
  const failed=fixture({admin:true,failUpdates:true});assert.equal((await failed.call('/payslip-files',{method:'POST',body:importForm()})).status,500);assert.equal(failed.state.writes,0);assert.equal(failed.state.removes[0],failed.state.uploads[0].path);
});
test('envio individual preserva nome e observação no próprio cadastro',async()=>{
  const f=fixture(),body=new FormData();body.append('titulo','Meu comprovante');body.append('observacoes','Atualização cadastral');body.append('file',new File(['conteudo'],'comprovante.pdf',{type:'application/pdf'}));assert.equal((await f.call('/employee-files',{method:'POST',body})).status,201);const d=f.state.row.payload.funcionarios[0].documentos[1];assert.equal(d.titulo,'Meu comprovante');assert.equal(d.observacoes,'Atualização cadastral');const data=await (await f.call()).json();assert.equal(data.data.funcionarios[0].documentos[1].titulo,'Meu comprovante');
});

test('plano externo exige administrador e valida o lote inteiro antes de assinar',async()=>{
  const body={files:[{employeeId:'F1',employeeName:'Ana Silva',nome:'2025-11 - Holerite - ANA SILVA.pdf',titulo:'2025-11 - Holerite',size:100,sha256:'a'.repeat(64)}]};
  assert.equal((await fixture().call('/payslip-upload-plan',{method:'POST',body})).status,403);
  const f=fixture({admin:true}),r=await f.call('/payslip-upload-plan',{method:'POST',body});assert.equal(r.status,200);const b=await r.json();assert.equal(b.entries.length,1);assert.equal(b.entries[0].objectPath,'funcionarios/F1/holerites/'+('a'.repeat(64))+'.pdf');assert.equal(f.state.writes,0);
  const bad=fixture({admin:true});body.files.push({...body.files[0],employeeName:'Outra Pessoa'});assert.equal((await bad.call('/payslip-upload-plan',{method:'POST',body})).status,400);assert.equal(bad.state.signed.length,0);
});
