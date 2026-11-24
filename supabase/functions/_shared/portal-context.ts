// Delegates identity and PIN-only policy to the Portal; never trusts a decoded token.
export async function portalContext(request: Request, app: string) {
  const authorization=request.headers.get('authorization')||'';
  if(!/^Bearer [^\s]{20,9000}$/.test(authorization))throw new Error('UNAUTHENTICATED');
  const response=await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/portal-api/context`,{
    headers:{authorization},cache:'no-store',signal:AbortSignal.timeout(15000)
  });
  if(response.status===401)throw new Error('UNAUTHENTICATED');
  if(response.status===403)throw new Error('FORBIDDEN');
  if(!response.ok)throw new Error('AUTH_UNAVAILABLE');
  const context=await response.json();
  if(context.authenticated!==true||!context.user?.email||!Array.isArray(context.apps)||!context.apps.includes(app))throw new Error('FORBIDDEN');
  return context;
}
