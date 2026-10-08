import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(message, status = 0, code = 'REQUEST_FAILED') { super(message); this.status = status; this.code = code; }
}
let apiMode='admin';
let apiGeneration=0;
try { if(sessionStorage.getItem('oasis-console-mode')==='partner')apiMode='partner'; } catch {}
export const getApiMode=()=>apiMode;
export function setApiMode(mode){
  if(!['admin','partner'].includes(mode))throw new Error('Unknown console mode');
  apiMode=mode;apiGeneration++;try{sessionStorage.setItem('oasis-console-mode',mode);}catch{}
  window.dispatchEvent(new CustomEvent('oasis:api-mode',{detail:{mode}}));
}
function scopedPath(path,mode){
  if(mode!=='partner'||!path.startsWith('/api/admin/'))return path;
  if(!/^\/api\/admin\/(?:apps(?:\/|$)|overview(?:-activity)?$|rounds$|operations$|audit$|health$|login$|session$|logout$|password$)/.test(path))throw new ApiError('此功能仅供平台管理员使用。',403,'SCOPE_FORBIDDEN');
  return path.replace('/api/admin/','/api/partner/');
}
export async function api(path, { method = 'GET', body, signal, mode=apiMode } = {}) {
  const generation=apiGeneration;
  const target=scopedPath(path,mode);
  let response;
  try {
    response = await fetch(target, { method, credentials: 'same-origin', cache: 'no-store', signal, headers: { Accept: 'application/json', ...(path.endsWith('/overview-activity') ? { 'X-Oasis-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(method === 'GET' ? '无法连接后台，请检查本地服务后重试。' : '网络中断，操作结果尚未确认。请刷新查验，避免重复提交。');
  }
  let data;
  try { data = await response.json(); } catch { throw new ApiError('后台未返回有效 JSON，请检查 API 服务与代理配置。', response.status); }
  if (!response.ok) {
    // A late rejection from an earlier login must not sign out its successor,
    // including a new login in the same console mode.
    if (response.status === 401 && generation===apiGeneration && mode===apiMode && !signal?.aborted && !/^\/api\/(admin|partner)\/(login|session)$/.test(target)) window.dispatchEvent(new CustomEvent('oasis:unauthorized',{detail:{mode:target.startsWith('/api/partner/')?'partner':'admin'}}));
    throw new ApiError(data.error?.message || data.message || (typeof data.error === 'string' ? data.error : `请求失败（HTTP ${response.status}）`), response.status, data.error?.code || data.code);
  }
  return data;
}
export function useApi(path, enabled = true) {
  const [mode,setMode]=useState(getApiMode);
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion(v => v + 1), []);
  useEffect(()=>{const changed=()=>setMode(getApiMode());window.addEventListener('oasis:api-mode',changed);return()=>window.removeEventListener('oasis:api-mode',changed);},[]);
  useEffect(() => {
    if (!enabled) { setState({ data: null, loading: false, error: '' }); return undefined; }
    const controller = new AbortController();
    setState({ data: null, loading: true, error: '' });
    api(path, { signal: controller.signal, mode }).then(data => { if (!controller.signal.aborted) setState({ data, loading: false, error: '' }); }).catch(error => { if (!controller.signal.aborted) setState({ data: null, loading: false, error: error.message }); });
    return () => controller.abort();
  }, [path, enabled, version, mode]);
  return { ...state, refresh };
}
export function formatMinor(value, scale = 2) {
  try { const n = BigInt(value ?? '0'); const sign = n < 0n ? '−' : ''; const digits = (n < 0n ? -n : n).toString().padStart(scale + 1, '0'); const whole = (scale ? digits.slice(0, -scale) : digits).replace(/\B(?=(\d{3})+(?!\d))/g, ','); return sign + whole + (scale ? '.' + digits.slice(-scale) : ''); } catch { return '—'; }
}
