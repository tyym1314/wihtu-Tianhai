import { Activity, RefreshCcw, ShieldCheck } from 'lucide-react';
import { useApi } from '../api.js';
import ApiState from './ApiState.jsx';
export default function ServiceHealth(){
 const health=useApi('/api/admin/health'),dependencies=health.data?.wallet_dependencies;
 const labels={ok:'检查通过',unavailable:'未通过',app_check_required:'需按应用核对'};
 return <section className="panel service-health"><div className="panel-head"><div><div className="portal-kicker"><Activity size={15}/>LIVE SERVICE STATUS</div><h2>实际服务健康</h2><p>读取当前后台；检查失败时不保留上次成功状态。</p></div><button className="button button-ghost" onClick={health.refresh} disabled={health.loading}><RefreshCcw size={15}/>重新检查</button></div><ApiState loading={health.loading} error={health.error} refresh={health.refresh}>
  <div className="health-grid">{[['api','平台 API'],['database','数据存储'],['wallet','当前必需钱包依赖']].map(([key,title])=><div key={key}><span className={`status-dot ${health.data?.[key]==='ok'?'':'health-warning'}`}/><span>{title}</span><strong>{labels[health.data?.[key]]??'状态未知'}</strong></div>)}<div><ShieldCheck size={15}/><span>生产开放</span><strong>{health.data?.production_enabled===false?'服务端锁定':health.data?.production_enabled===true?'服务端报告开放':'未返回'}</strong></div></div>
  {dependencies?.providers&&<p className="launch-feedback">平台自有账本 {dependencies.providers.platform??0} 个应用 · 外部钱包 {dependencies.providers.external??0} 个应用 · 参考钱包 {dependencies.providers.reference??0} 个应用</p>}
  {dependencies?.providers?.external>0&&dependencies.external_connectivity==='not_checked'&&<p className="launch-feedback" role="status">外部钱包连接尚未验证；依赖检查通过不代表外部余额或结算可用。</p>}
 </ApiState></section>;
}
