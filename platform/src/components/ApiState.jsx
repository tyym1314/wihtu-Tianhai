import { LoaderCircle, RefreshCcw, ShieldAlert, TriangleAlert } from 'lucide-react';
export default function ApiState({ loading, error, refresh, children, empty = false, message = '暂无记录' }) {
  if (loading) return <div className="panel api-state" role="status"><LoaderCircle className="portal-spin" size={24}/><strong>正在读取后台数据</strong><p>等待当前后台服务返回。</p></div>;
  if (error) return <div className="panel api-state api-error" role="alert"><TriangleAlert size={24}/><strong>暂时无法加载</strong><p>{error}</p>{refresh && <button className="button" onClick={refresh}><RefreshCcw size={15}/>重新读取</button>}</div>;
  if (empty) return <div className="panel api-state"><strong>{message}</strong><p>后台尚未产生对应记录。</p></div>;
  return children;
}
