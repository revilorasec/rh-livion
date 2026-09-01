from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')

s = s.replace(
    'const AUTH_REDIRECT_URI = "https://revilorasec.github.io/fretes-livion/";',
    'const AUTH_REDIRECT_URI = "https://revilorasec.github.io/rh-livion/";'
)

anchor = 'async function boot(){\n  loadCfg();'
if anchor not in s:
    raise SystemExit('boot anchor not found')

portal_js = '''const RH_API="https://kvfjjtkwxxbvzlicwnrz.supabase.co/functions/v1/rh-api";
let PORTAL_SESSION=null, PORTAL_BOOTSTRAP_PENDING=false, PORTAL_DATA_META=null;
function rhApi(path,opt={}){
  if(!PORTAL_SESSION?.token) throw new Error("Sessão do Portal indisponível");
  return fetch(RH_API+path,{...opt,headers:{Authorization:"Bearer "+PORTAL_SESSION.token,"Content-Type":"application/json",...(opt.headers||{})},cache:"no-store"}).then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||("HTTP "+r.status));return b;});
}
function waitPortalSession(ms=7000){
  if(PORTAL_SESSION) return Promise.resolve(PORTAL_SESSION);
  return new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error("Sessão do Portal não recebida")),ms);const h=e=>{if(e.origin!=="https://portal.livionsolutions.com.br"&&e.origin!=="https://revilorasec.github.io")return;if(e.data?.type!=="PORTAL_SESSION"||!e.data?.token)return;clearTimeout(t);window.removeEventListener("message",h);PORTAL_SESSION=e.data;resolve(PORTAL_SESSION)};window.addEventListener("message",h);});
}
async function bootFromPortal(){
  gate(`<div class="card"><div class="mark">RH</div><h1>Recursos Humanos</h1><p>Validando sua permissão no Portal Livion…</p><div class="spin" style="margin:0 auto"></div></div>`);
  try{
    const ps=await waitPortalSession();
    account={name:ps.context?.user?.name||ps.context?.user?.email||"Usuário",username:ps.context?.user?.email||""};
    const j=await rhApi("/data"); PORTAL_DATA_META=j;
    if(!j.empty){ DB=j.data; rawSnapshot=JSON.stringify(DB); normalizeDB(); startApp(); return; }
    if(ps.context?.administrator || ps.context?.userType==="INTERNO"){
      PORTAL_BOOTSTRAP_PENDING=true;
      await legacyBoot();
      return;
    }
    showFatal("A base do RH ainda não foi inicializada pelo administrador.");
  }catch(e){ console.error(e); showFatal("Não foi possível validar o acesso pelo Portal: "+esc(e.message||String(e))); }
}
async function boot(){
  if(window.self!==window.top) return bootFromPortal();
  return legacyBoot();
}

'''

s = s.replace(anchor, portal_js + 'async function legacyBoot(){\n  loadCfg();', 1)

old = '  normalizeDB();\n}\nasync function saveDB(){'
new = '''  normalizeDB();
  if(PORTAL_BOOTSTRAP_PENDING && PORTAL_SESSION?.token){
    try{ await rhApi("/bootstrap",{method:"POST",body:JSON.stringify({data:DB})}); PORTAL_BOOTSTRAP_PENDING=false; }
    catch(e){ if(!String(e.message||e).includes("já inicializada")) console.warn("Bootstrap RH no Portal falhou",e); }
  }
}
async function saveDB(){'''
if old not in s:
    raise SystemExit('loadDB/saveDB anchor not found')
s = s.replace(old, new, 1)

save_anchor = 'async function saveDB(){\n  busy(true);'
save_repl = '''async function saveDB(){
  if(PORTAL_SESSION?.token && PORTAL_SESSION?.context?.userType!=="INTERNO"){
    const pm=PORTAL_DATA_META?.permissions||{};
    if(!(pm.edit&&pm.salary&&pm.bank&&pm.sensitive&&pm.documents)){ toast("🔒 Seu perfil não possui permissão para alterar a base completa do RH."); return false; }
    busy(true);
    try{const body=JSON.stringify(DB,null,2);const j=await rhApi("/data",{method:"PUT",body:JSON.stringify({data:DB})});rawSnapshot=body;PORTAL_DATA_META={...(PORTAL_DATA_META||{}),revision:j.revision};return true;}catch(e){toast("❌ "+(e.message||"Erro ao salvar"));return false;}finally{busy(false);}
  }
  busy(true);'''
if save_anchor not in s:
    raise SystemExit('saveDB anchor not found')
s = s.replace(save_anchor, save_repl, 1)

s = s.replace(
    'async function uploadFile(rel, blob, mime){\n  if(blob.size < 3800000){',
    'async function uploadFile(rel, blob, mime){\n  if(PORTAL_SESSION?.token && PORTAL_SESSION?.context?.userType!=="INTERNO") throw new Error("Arquivos do RH não estão liberados para este perfil externo.");\n  if(blob.size < 3800000){',
    1
)
s = s.replace(
    'async function fileUrl(rel){\n  if(urlCache.has(rel)) return urlCache.get(rel);',
    'async function fileUrl(rel){\n  if(PORTAL_SESSION?.token && PORTAL_SESSION?.context?.userType!=="INTERNO") return null;\n  if(urlCache.has(rel)) return urlCache.get(rel);',
    1
)
s = s.replace(
    'async function thumbUrl(rel){\n  if(thumbCache.has(rel)) return thumbCache.get(rel);',
    'async function thumbUrl(rel){\n  if(PORTAL_SESSION?.token && PORTAL_SESSION?.context?.userType!=="INTERNO") return null;\n  if(thumbCache.has(rel)) return thumbCache.get(rel);',
    1
)

p.write_text(s, encoding='utf-8')

checks = [
    'const AUTH_REDIRECT_URI = "https://revilorasec.github.io/rh-livion/"',
    'function bootFromPortal',
    'PORTAL_SESSION',
    'RH_API=',
    'async function legacyBoot'
]
for c in checks:
    if c not in s:
        raise SystemExit(f'missing verification marker: {c}')
print('RH Portal integration patch applied')
