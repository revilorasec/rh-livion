from pathlib import Path

path = Path("index.html")
text = path.read_text(encoding="utf-8")

old_save = '''async function saveDB(){
  if(PORTAL_SESSION?.token && PORTAL_SESSION?.context?.userType!=="INTERNO"){'''
new_save = '''async function saveDB(){
  // Dentro do Portal, todos os usuarios autorizados persistem pela API central do RH.
  // O OneDrive fica restrito ao modo legado, quando o app e aberto fora do Portal.
  if(PORTAL_SESSION?.token){'''

if old_save not in text:
    raise SystemExit("Trecho esperado de saveDB nao encontrado; patch abortado com seguranca.")
text = text.replace(old_save, new_save, 1)

old_reload = '''A.recarregar = async ()=>{ busy(true); try{ thumbCache.clear(); urlCache.clear(); await loadDB(); render(); toast("✅ Dados atualizados"); }catch(e){ toast("❌ "+e.message); } busy(false); };'''
new_reload = '''A.recarregar = async ()=>{ busy(true); try{ thumbCache.clear(); urlCache.clear(); if(PORTAL_SESSION?.token){ const j=await rhApi("/data"); PORTAL_DATA_META=j; if(j.empty) throw new Error("Base RH vazia"); DB=j.data; rawSnapshot=JSON.stringify(DB); normalizeDB(); } else { await loadDB(); } render(); toast("✅ Dados atualizados"); }catch(e){ toast("❌ "+e.message); } busy(false); };'''

if old_reload not in text:
    raise SystemExit("Trecho esperado de A.recarregar nao encontrado; patch abortado com seguranca.")
text = text.replace(old_reload, new_reload, 1)

old_ver = 'const APP_VER = "1.8";'
new_ver = 'const APP_VER = "1.8.3";'
if old_ver in text:
    text = text.replace(old_ver, new_ver, 1)
elif new_ver not in text:
    raise SystemExit("Versao esperada do app nao encontrada; patch abortado com seguranca.")

path.write_text(text, encoding="utf-8")
print("RH Portal persistence patch applied")
