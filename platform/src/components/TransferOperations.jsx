import {useState} from 'react';
import {useApi,formatMinor} from '../api.js';
import ApiState from './ApiState.jsx';
import './transfer-operations.css';

const states={PENDING:'待核实',SUCCEEDED:'已完成',REJECTED:'已拒绝'};
const local={FUNDS_HELD:'划出资金保留中',CAPACITY_HELD:'划入额度保留中',HOLD_RELEASED:'原单保留已释放',CREDITED:'平台已入账',DEBITED:'平台已划出'};
const remote={NOT_OBSERVED:'尚无结果',UNKNOWN:'结果未知',PENDING:'第三方待处理',NOT_FOUND:'上次查单未找到',SUCCEEDED:'已确认成功',REJECTED:'已确认拒绝'};
const retries={IN_FLIGHT:'处理中',BACKOFF:'等待后台下次查单',DUE:'等待后台处理',TERMINAL:'终态',UNAVAILABLE:'需人工核查'};
const errors={OUTCOME_UNKNOWN:'外部结果未知',RECEIPT_INVALID:'回执校验未通过',DUPLICATE_EXTERNAL_TRANSACTION:'外部交易号重复',OUTBOX_MISSING:'处理记录缺失',UNCLASSIFIED:'未识别的观察结果'};
const value=x=>x===null||x===undefined?'—':String(x);

export default function TransferOperations({appScope='all'}){
 const [state,setState]=useState(''),[query,setQuery]=useState(''),[requestId,setRequestId]=useState(''),[cursor,setCursor]=useState(null),[selected,setSelected]=useState(null);
 const params=new URLSearchParams({limit:'25',...(appScope==='all'?{}:{app_id:appScope}),...(state?{state}:{}),...(requestId?{request_id:requestId}:{}),...(cursor?{cursor}: {})});
 const list=useApi('/api/admin/transfers?'+params);
 const refresh=()=>{setCursor(null);setSelected(null);list.refresh();};
 return <section className="panel transfer-operations" aria-label="资金划转查询">
  <div className="panel-head"><div><h2>资金划转查询</h2><p>只读查看订单记录的占用和入账状态，未实时校验钱包与账本一致性。超时不等于失败；本页不会重试、退款或解除资金保留。</p></div><button className="button" onClick={refresh}>刷新划转</button></div>
  <form className="transfer-filters" onSubmit={e=>{e.preventDefault();setCursor(null);setSelected(null);setRequestId(query.trim());}}>
   <label>划转状态<select aria-label="划转状态" value={state} onChange={e=>{setState(e.target.value);setCursor(null);setSelected(null);}}><option value="">全部状态</option>{Object.entries(states).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
   <label>原始请求号<input aria-label="划转原始请求号" value={query} maxLength={128} pattern="[A-Za-z0-9_-]*" onChange={e=>setQuery(e.target.value)}/></label><button className="button" type="submit">查询原单</button>
  </form>
  <ApiState loading={list.loading} error={list.error} refresh={list.refresh} empty={!list.data?.transfers.length} message="暂无符合条件的资金划转">
   <div className="table-wrap"><table className="data-table"><thead><tr><th>原单 / 应用</th><th>方向 / 金额</th><th>双边状态</th><th>等待 / 后台处理</th><th/></tr></thead><tbody>{list.data?.transfers.map(t=><tr key={t.transfer_id}>
    <td><code>{t.request_id}</code><small>{t.app_name} · {t.app_id}</small><small>{t.transfer_id}</small></td>
    <td>{t.direction==='IN'?'第三方 → 平台':'平台 → 第三方'}<strong>{formatMinor(t.amount_minor,t.currency_scale)} {t.currency_id}</strong></td>
    <td><span className="badge">{states[t.state]||t.state}</span><small>{local[t.local_state]||t.local_state}</small><small>{remote[t.external_state]||t.external_state}</small></td>
    <td>{t.pending_age_seconds===null?'已终结':`待核实 ${t.pending_age_seconds} 秒`}<small>尝试 {value(t.attempts)} 次 · {retries[t.retry_state]}</small><small>{t.next_attempt_at||'—'}</small>{t.error_category&&<small role="note">{errors[t.error_category]||'需人工核查'}</small>}</td>
    <td><button className="text-button" aria-label={`查看划转 ${t.request_id}`} onClick={()=>setSelected({id:t.transfer_id,app:t.app_id})}>原单详情</button></td>
   </tr>)}</tbody></table></div>
  </ApiState>
  <div className="table-footer"><span>读回时间 {list.data?.as_of||'—'} · 状态以本次读回为准</span><button className="button" disabled={list.loading||!list.data?.next_cursor} onClick={()=>{setSelected(null);setCursor(list.data.next_cursor);}}>下一页划转</button>{cursor&&<button className="button" onClick={refresh}>返回首批划转</button>}</div>
  {selected&&<TransferDetail key={selected.id} selected={selected} close={()=>setSelected(null)}/>}
 </section>;
}
function TransferDetail({selected,close}){
 const r=useApi(`/api/admin/transfers/${selected.id}?app_id=${encodeURIComponent(selected.app)}`),t=r.data?.transfer;
 return <div className="drawer-backdrop" onClick={e=>{if(e.target===e.currentTarget)close();}}><section className="ledger-drawer" role="dialog" aria-modal="true" aria-label="资金划转原单详情"><header><h2>资金划转原单</h2><button className="button" onClick={close}>关闭划转详情</button></header><div className="drawer-content"><ApiState loading={r.loading} error={r.error} refresh={r.refresh}>{t&&<>
  <p>{states[t.state]} · {local[t.local_state]} · {remote[t.external_state]}</p>
  <p>订单记录的资金保留：{t.hold.kind==='FUNDS_RESERVED'?'划出资金':t.hold.kind==='CREDIT_CAPACITY_RESERVED'?'划入额度':'无'} {formatMinor(t.hold.amount_minor,t.currency_scale)} {t.currency_id}</p>
  <p>新单准入：应用 {value(t.admission.app_status)} / 绑定 {value(t.admission.binding_status)} / 账户映射 {t.admission.account_active?'有效':'未启用'}。此信息不代表旧单已停止恢复。</p>
  <dl className="transfer-facts">{[['平台划转号',t.transfer_id],['原始请求号',t.request_id],['应用',t.app_id],['外部用户标识',t.external_user_id],['绑定',t.binding_id],['账户映射',t.account_id],['第三方原操作号',t.external_operation_id],['第三方交易号',t.external_transaction_id],['平台账本交易号',t.ledger_transaction_id],['原单 SHA256',t.request_sha256],['拒绝码',t.receipt?.rejection_code],['创建时间',t.created_at],['更新时间',t.updated_at],['最后观察',t.observation],['错误类别',t.error_category],['下次后台尝试',t.next_attempt_at]].map(([label,v])=><div key={label}><dt>{label}</dt><dd>{value(v)}</dd></div>)}</dl>
  <p>此处展示已保存的原单证据；入账和占用状态由订单记录推导，未实时验证双方账本。不主动向第三方查单。未知结果需核查双方账本，不应重复发起划转。</p><button className="button" onClick={r.refresh}>只读刷新详情</button>
 </>}</ApiState></div></section></div>;
}
