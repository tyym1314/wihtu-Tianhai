import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowRight, BookOpen, Check, CheckCircle2, ChevronRight, CircleDashed, ClipboardCheck, Code2, Copy, FileJson, FlaskConical, KeyRound, LockKeyhole, Play, RefreshCcw, Rocket, ShieldCheck, Terminal, TriangleAlert, Wallet, Workflow } from 'lucide-react';
import './portal.css';
import ServiceHealth from '../components/ServiceHealth.jsx';
import SandboxLauncher from '../components/SandboxLauncher.jsx';
import IntegrationPanel from '../components/IntegrationPanel.jsx';

const DOCS = [
  { id: 'quickstart', title: '快速开始', english: 'Quick start', icon: Rocket },
  { id: 'launch', title: '启动游戏', english: 'Game session', icon: Play },
  { id: 'wallet', title: '钱包协议', english: 'Wallet contract', icon: Wallet },
  { id: 'signature', title: '请求签名', english: 'Authentication', icon: KeyRound },
  { id: 'errors', title: '错误与恢复', english: 'Recovery', icon: RefreshCcw },
  { id: 'acceptance', title: '接入验收', english: 'Acceptance', icon: ClipboardCheck },
];
const LANGUAGES = ['Node.js', 'Java', 'PHP'];
const SCENARIOS = [
  { id: 'success', name: '正常完成', caption: '双人各 100 入场，A 获胜' },
  { id: 'insufficient', name: '余额不足', caption: 'B 只有 80，A 的冻结被释放' },
  { id: 'timeout', name: '超时后查单', caption: '账务已执行，响应丢失后恢复' },
  { id: 'cancel', name: '取消与释放', caption: '未满员取消，服务费为零' },
  { id: 'duplicate', name: '重复结算', caption: '复用同一业务号，不多发金币' },
];

const SIGNATURE_CODE = {
  'Node.js': `import { createHash, createHmac, randomBytes } from 'node:crypto';

// 服务端示例。secret 以 Base64 发放，先解码。
function signRequest(method, path, body, requestId) {
  const keyId = process.env.GP_KEY_ID;
  const secret = Buffer.from(process.env.GP_SECRET_B64, 'base64');
  const direction = 'partner-to-platform';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  const digest = createHash('sha256').update(body, 'utf8').digest('hex');
  const canonical = [
    'GP-HMAC-SHA256-V1', direction, keyId,
    timestamp, nonce, requestId,
    method.toUpperCase(), path, digest
  ].join('\\n'); // 恰好 9 行，末尾无换行
  const signature = createHmac('sha256', secret)
    .update(canonical, 'utf8').digest('hex');
  return {
    'X-GP-Key-Id': keyId,
    'X-GP-Direction': direction,
    'X-GP-Timestamp': timestamp,
    'X-GP-Nonce': nonce,
    'X-GP-Request-Id': requestId,
    'X-GP-Signature': 'v1=' + signature
  };
}
// 重试保留 requestId、path 和原始 body；换 nonce/时间。
// GET 对空 body 取 SHA256；V1 路径没有 query。`,
  'Java': `// Java 17+ 标准库，放在合作方后端类中。
static java.util.Map<String, String> signRequest(
    String method, String path, String body, String requestId)
    throws Exception {
  var utf8 = java.nio.charset.StandardCharsets.UTF_8;
  String keyId = System.getenv("GP_KEY_ID");
  byte[] secret = java.util.Base64.getDecoder()
      .decode(System.getenv("GP_SECRET_B64"));
  String direction = "partner-to-platform";
  String timestamp = Long.toString(java.time.Instant.now().getEpochSecond());
  byte[] random = new byte[16];
  new java.security.SecureRandom().nextBytes(random);
  var hex = java.util.HexFormat.of();
  String nonce = hex.formatHex(random);
  String digest = hex.formatHex(java.security.MessageDigest
      .getInstance("SHA-256").digest(body.getBytes(utf8)));
  String canonical = String.join("\\n", "GP-HMAC-SHA256-V1",
      direction, keyId, timestamp, nonce, requestId,
      method.toUpperCase(java.util.Locale.ROOT), path, digest);
  var mac = javax.crypto.Mac.getInstance("HmacSHA256");
  mac.init(new javax.crypto.spec.SecretKeySpec(secret, "HmacSHA256"));
  String sig = hex.formatHex(mac.doFinal(canonical.getBytes(utf8)));
  return java.util.Map.of(
      "X-GP-Key-Id", keyId, "X-GP-Direction", direction,
      "X-GP-Timestamp", timestamp, "X-GP-Nonce", nonce,
      "X-GP-Request-Id", requestId, "X-GP-Signature", "v1=" + sig);
}
// 9 行 LF，末尾无换行。发送原始 UTF-8 body。`,
  'PHP': `<?php
// PHP 原生函数，不是平台 SDK。
function signRequest($method, $path, $body, $requestId) {
    $keyId = getenv('GP_KEY_ID');
    $secret = base64_decode(getenv('GP_SECRET_B64'), true);
    if ($secret === false) throw new RuntimeException('Invalid Base64');
    $direction = 'partner-to-platform';
    $timestamp = (string) time();
    $nonce = bin2hex(random_bytes(16));
    $digest = hash('sha256', $body);
    $canonical = implode("\\n", [
        'GP-HMAC-SHA256-V1', $direction, $keyId,
        $timestamp, $nonce, $requestId,
        strtoupper($method), $path, $digest,
    ]); // 9 行，末尾没有换行
    $sig = hash_hmac('sha256', $canonical, $secret);
    return [
        'X-GP-Key-Id: ' . $keyId,
        'X-GP-Direction: ' . $direction,
        'X-GP-Timestamp: ' . $timestamp,
        'X-GP-Nonce: ' . $nonce,
        'X-GP-Request-Id: ' . $requestId,
        'X-GP-Signature: v1=' . $sig,
    ];
}
// 重试复用业务号与 body，更新 nonce 和时间戳。`,
};

function getCode(doc, language) {
  if (doc === 'signature') return SIGNATURE_CODE[language];
  const scope = { partner_id: 'partner_demo', app_id: 'app_demo', environment: 'sandbox', wallet_scope_id: 'main', currency_id: 'GOLD' };
  const launchPayload = { ...scope, request_id: 'launch_intent_0001', external_user_id: 'player_a', game_id: 'match', locale: 'en', host_platform: 'android' };
  if (doc === 'quickstart' || doc === 'launch') {
    const json = JSON.stringify(launchPayload, null, 2);
    if (language === 'Node.js') return `// 合作方后端；signRequest 见「请求签名」。
const requestId = 'launch_intent_0001';
const path = '/v1/sessions';
const body = JSON.stringify(${json});

const response = await fetch(
  'https://api.game-platform.invalid' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...signRequest('POST', path, body, requestId)
    }, body
  }
);
if (!response.ok) throw new Error('检查错误码与原业务号');
const { entry_url, launch_code } = await response.json();
// WebView 打开 entry_url，再经受限通道传启动码。
// POST /v1/launch/exchange 单次兑换；启动码有效 60 秒。
// 这是协议示例，域名不可调用，另有本地 Node 参考客户端，见左侧资源。`;
    if (language === 'Java') return `// Java 17+；signRequest 见「请求签名」。
String requestId = "launch_intent_0001";
String path = "/v1/sessions";
String body = """
${json.split('\n').map((line) => `    ${line}`).join('\n')}
    """;
var builder = java.net.http.HttpRequest.newBuilder()
    .uri(java.net.URI.create("https://api.game-platform.invalid" + path))
    .header("Content-Type", "application/json");
signRequest("POST", path, body, requestId).forEach(builder::header);
var response = java.net.http.HttpClient.newHttpClient().send(
    builder.POST(java.net.http.HttpRequest.BodyPublishers.ofString(body)).build(),
    java.net.http.HttpResponse.BodyHandlers.ofString());
// 校验 HTTP 状态后，解析 entry_url / launch_code。
// /v1/launch/exchange 单次兑换；不重复参赛扣款。
// 此为后端协议示例，占位域名不可调用。`;
    return `<?php
// signRequest 见「请求签名」。以下放在合作方后端。
$requestId = 'launch_intent_0001';
$path = '/v1/sessions';
$body = <<<'JSON'
${json}
JSON;
$headers = array_merge(['Content-Type: application/json'],
    signRequest('POST', $path, $body, $requestId));
$ch = curl_init('https://api.game-platform.invalid' . $path);
curl_setopt_array($ch, [
    CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body,
    CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true,
]);
$result = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
// 检查 $status 后解析 entry_url / launch_code。
// 启动码经受限通道交付，不放入长期 URL。
// 此为协议示例，非现成 SDK；域名不可调用。`;
  }
  const payload = doc === 'wallet'
    ? { ...scope, request_id: 'settle_demo_001', match_id: 'match_demo_001', resolution: 'completed', result_hash: '0'.repeat(64), payouts: [{ external_user_id: 'player_a', seat_index: 0, rank: 1, payout_minor: '19000' }, { external_user_id: 'player_b', seat_index: 1, rank: 2, payout_minor: '0' }], fee_minor: '1000' }
    : doc === 'errors'
      ? { operation_id: 'settle_demo_001', kind: 'settle_match', state: 'SUCCEEDED' }
      : { environment: 'sandbox', test: 'duplicate_settlement', repetitions: 10, currency_scale: 2, expected_minor: { player_a: '109000', player_b: '90000', fee: '1000' }, real_execution: false };
  const json = JSON.stringify(payload, null, 2);
  const note = doc === 'wallet' ? 'POST /wallet/v1/matches/settle；scale=2，19000 表示 190 币。\n// result_hash 全零仅占位；真实值必须匹配已冻结结果。' : doc === 'errors' ? '查单响应字段节选；完整对象还含 scope、receipt 等，见 OpenAPI。' : '验收断言定义，不是已运行的报告；金额均为最小单位。';
  if (language === 'Node.js') return `// ${note}
const payload = ${json};
// 钱包返回的 operation_id 等于写入时 request_id。
// 本地参考钱包已实现事务、入账与查单；合作方需在自己的钱包实现同样契约。`;
  if (language === 'Java') return `// ${note}
// Java 17+ JSON 文本块示例，非现成 SDK。
String payload = """
${json.split('\n').map((line) => `    ${line}`).join('\n')}
    """;
// 请求头 X-GP-Request-Id 须与正文 request_id 一致。`;
  return `<?php
// ${note}
$payload = <<<'JSON'
${json}
JSON;
$data = json_decode($payload, true, 512, JSON_THROW_ON_ERROR);
// 正式实现须在同一事务中保存分录与幂等记录。`;
}

const snap = (a = 1000, b = 1000, holdA = 0, holdB = 0, pool = 0, fee = 0) => ({ a, b, holdA, holdB, pool, fee });
function makeScenario(id) {
  const initial = id === 'insufficient' ? snap(1000, 80) : snap();
  const reserveA = { title: '冻结 A 的入场金币', detail: 'Reserve · available −100 / frozen +100', state: snap(900, initial.b, 100) };
  if (id === 'insufficient') return { initial, steps: [reserveA, { title: 'B 的可用余额不足', detail: 'INSUFFICIENT_FUNDS · 拒绝冻结，不开局', state: snap(900, 80, 100), tone: 'warning' }, { title: '释放 A 的冻结', detail: 'Release · 取消留痕，迟到请求不能再次冻结', state: snap(1000, 80) }], result: '未成局，A 全额释放；未产生服务费。' };
  if (id === 'cancel') return { initial, steps: [reserveA, { title: '等待超时，取消房间', detail: '取消状态先持久化，禁止迟到玩家触发成局', state: snap(900, 1000, 100), tone: 'warning' }, { title: '释放冻结，恢复余额', detail: 'Release · 100 返回可用余额，费用为 0', state: snap() }], result: '房间已取消，两个账户均保留原余额。' };
  const steps = [reserveA, { title: '冻结 B 的入场金币', detail: 'Reserve · 两位玩家均已准备', state: snap(900, 900, 100, 100) }, { title: '原子捕获并开始对局', detail: 'CaptureRound · 全部确认后开局，奖池 200', state: snap(900, 900, 0, 0, 200) }, { title: '持久化比赛结果', detail: 'A 获胜 · 固定 result_v1 与结算业务号', state: snap(900, 900, 0, 0, 200) }];
  if (id === 'timeout') steps.push({ title: '钱包执行成功，响应丢失', detail: '模拟网络超时 · 标记待确认，显示上次确认余额', state: snap(900, 900, 0, 0, 200), tone: 'warning' }, { title: '用原业务号查单恢复', detail: 'GetOperation → SUCCEEDED · 不再次扣款或派奖', state: snap(1090, 900, 0, 0, 0, 10) });
  else steps.push({ title: '原子结算奖励与费用', detail: 'SettleRound · A 获得 190，费用账户记 10', state: snap(1090, 900, 0, 0, 0, 10) });
  if (id === 'duplicate') steps.push({ title: '重复发送同一结算 10 次', detail: '同 request_id、同参数 → 复用原结果，余额不变', state: snap(1090, 900, 0, 0, 0, 10) });
  return { initial, steps, result: id === 'duplicate' ? '重复结算没有多发金币，A 仍为 1,090。' : id === 'timeout' ? '查单确认原结算成功，没有重新比赛或生成另一笔派奖。' : '200 入场金币 = 190 奖励 + 10 服务费。A 净增加 90。' };
}

export default function Developer({ environment = 'sandbox', notify = () => {}, navigate = () => {}, apps = [] }) {
  const [activeDoc, setActiveDoc] = useState('quickstart');
  const [language, setLanguage] = useState('Node.js');
  const [copied, setCopied] = useState(false);
  const [scenarioId, setScenarioId] = useState('success');
  const [completed, setCompleted] = useState(0);
  const [running, setRunning] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [simulationEnvironment, setSimulationEnvironment] = useState(environment);
  const live = environment === 'live';
  const scenario = useMemo(() => makeScenario(scenarioId), [scenarioId]);
  const visibleCompleted = simulationEnvironment === environment ? Math.min(Math.max(completed, 0), scenario.steps.length) : 0;
  const balance = scenario.steps[visibleCompleted - 1]?.state ?? scenario.initial;
  const finished = visibleCompleted === scenario.steps.length;
  const code = getCode(activeDoc, language);
  useEffect(() => { setRunning(false); setCompleted(0); setFeedback(''); setSimulationEnvironment(environment); }, [environment]);
  useEffect(() => { setCopied(false); }, [activeDoc, language]);
  useEffect(() => {
    if (!running || live) return undefined;
    if (completed >= scenario.steps.length) { setRunning(false); setFeedback('本地流程演示完成。真实服务端与钱包验收尚未执行。'); return undefined; }
    const timer = window.setTimeout(() => setCompleted((value) => value + 1), 560);
    return () => window.clearTimeout(timer);
  }, [running, completed, scenario.steps.length, live]);
  const copyCode = async () => { try { await navigator.clipboard.writeText(code); setCopied(true); notify('协议参考代码已复制；请按当前沙箱接口调整，不是现成 SDK。'); } catch { notify('复制失败，请手动选择代码复制。'); } };
  const runDemo = () => { if (live || running) return; setCompleted(0); setFeedback(''); setRunning(true); };
  const reset = () => { setRunning(false); setCompleted(0); setFeedback('演示已重置，未改变任何真实账户。'); };
  const changeScenario = (id) => { setRunning(false); setCompleted(0); setFeedback(''); setScenarioId(id); };

  // Production has one partner integration path: signed sessions, /launch, and the 3-endpoint wallet.
  if (environment === 'production') return <div className="portal-page">
    <div className="portal-heading-row"><div><div className="eyebrow">DEVELOPER EXPERIENCE</div><h1 className="page-heading">开发者中心</h1><p className="subtitle">后端签名开会话，客户端打开启动页，钱包只需 3 个接口。</p></div><a className="button" href="/specs/partner-integration-production.md" target="_blank" rel="noreferrer"><BookOpen size={17} />正式接入指南<ArrowRight size={15} /></a></div>
    <section className="panel" style={{marginBottom:18}}><div className="ip-grid">
      <div className="ip-card"><div className="ip-step"><span>01</span><KeyRound size={19}/></div><h3>后端创建会话</h3><p>用 App 密钥签名调用 <code>POST /v1/sessions</code>，传入你的用户 ID、游戏和语言（zh-CN / en / ar），得到一次性启动码。</p></div>
      <div className="ip-card"><div className="ip-step"><span>02</span><Rocket size={19}/></div><h3>客户端打开游戏</h3><p>WebView 打开 <code>/launch/?game=…&amp;lang=…#code=…&amp;session=…</code>；H5 页面可用 <a href="/sdk/oasis-h5.mjs" download>H5 SDK</a> 嵌入。</p></div>
      <div className="ip-card"><div className="ip-step"><span>03</span><ShieldCheck size={19}/></div><h3>实现钱包 3 个接口</h3><p>查余额、扣款、加款，按 request_id 幂等。冻结、退款、派奖与概率责任由平台处理。</p></div>
    </div><div className="ip-resource-strip"><Terminal size={21}/><div><strong>参考资料</strong><span>签名示例、固定签名向量与机器契约。</span></div><a className="button button-ghost" href="/specs/examples/sdk-node.mjs" download><ArrowDownToLine size={14}/>Node 签名示例</a><a className="button button-ghost" href="/specs/examples/signature-vector.json" download><ArrowDownToLine size={14}/>签名向量</a></div></section>
    <IntegrationPanel apps={apps} notify={notify}/>
  </div>;

  return <div className="portal-page">
    <div className="portal-heading-row"><div><div className="eyebrow">DEVELOPER EXPERIENCE</div><h1 className="page-heading">开发者中心</h1><p className="subtitle">从一次安全连接，到每一局可靠结算。</p></div><a className="button button-ghost" href="/specs/openapi.json" target="_blank" rel="noreferrer"><FileJson size={17} />OpenAPI 草案<ArrowRight size={15} /></a></div>
    <div className={`portal-preview-note ${live ? 'portal-preview-note-live' : ''}`}><FlaskConical size={18} /><span>{live ? '生产环境 · 设计预览' : '阶段 F · 合作方自助接入'}<small>{live ? '本地演示已禁用；生产 API、SDK 与接入验收尚未开放。' : '接入检查连接真实后台并保存报告；附 H5 SDK 与独立宿主示例。下方五场景流程为浏览器演示。'}</small></span><span className="portal-micro-label">SANDBOX v0.6</span></div>

    <div className="developer-live-grid"><ServiceHealth/><SandboxLauncher apps={apps} environment={environment} notify={notify}/></div>
    <IntegrationPanel apps={apps} notify={notify}/>
    <div className="portal-doc-grid">
      <aside className="portal-doc-nav" aria-label="开发文档目录"><div className="portal-doc-nav-label">GET STARTED<span>06</span></div>{DOCS.map(({ id, title, english, icon: Icon }) => <button key={id} className={`portal-doc-nav-item ${activeDoc === id ? 'portal-doc-nav-active' : ''}`} aria-current={activeDoc === id ? 'page' : undefined} onClick={() => setActiveDoc(id)}><Icon size={17} /><span><strong>{title}</strong><small>{english}</small></span>{activeDoc === id && <ChevronRight size={14} />}</button>)}<div className="portal-doc-resources"><span>完整协议文件</span><a href="/specs/partner-integration-production.md" target="_blank" rel="noreferrer"><BookOpen size={14}/>正式接入指南（第三方 App）<ArrowDownToLine size={13}/></a><a href="/specs/towerlink-v2-integration.md" target="_blank" rel="noreferrer"><BookOpen size={14}/>连线占塔 v2 · 规则与房间接入<ArrowDownToLine size={13}/></a><a href="/specs/android-webview-integration.md" target="_blank" rel="noreferrer"><BookOpen size={14}/>Android 原生入口与全屏游戏<ArrowDownToLine size={13}/></a><a href="/specs/rate-limits.md" target="_blank" rel="noreferrer"><BookOpen size={14}/>请求保护与扩容说明<ArrowDownToLine size={13}/></a><a href="/specs/phase-f-self-integration.md" target="_blank" rel="noreferrer"><BookOpen size={14}/>阶段 F · 独立合作方接入<ArrowDownToLine size={13}/></a><a href="/specs/phase-e-local-integration.md" target="_blank" rel="noreferrer"><BookOpen size={14}/>阶段 E · 多人游戏接入与试玩<ArrowDownToLine size={13}/></a><a href="/specs/phase-b-local-integration.md" target="_blank" rel="noreferrer"><BookOpen size={14}/>本地沙箱接入<ArrowDownToLine size={13}/></a><a href="/specs/examples/sdk-node.mjs" target="_blank" rel="noreferrer"><Code2 size={14}/>Node 参考客户端<ArrowDownToLine size={13}/></a><a href="/specs/integration-guide.md" target="_blank" rel="noreferrer"><BookOpen size={14} />接入指南<ArrowDownToLine size={13} /></a><a href="/specs/wallet-protocol.md" target="_blank" rel="noreferrer"><Wallet size={14} />钱包协议<ArrowDownToLine size={13} /></a><a href="/specs/openapi.json" target="_blank" rel="noreferrer"><FileJson size={14} />OpenAPI<ArrowDownToLine size={13} /></a></div><div className="portal-doc-help"><Code2 size={21} /><strong>先有边界，再有连接</strong><p>App、用户、币种与环境均独立隔离。</p><button onClick={() => navigate('partners')}>管理应用 <ArrowRight size={14} /></button></div></aside>

      <article className="portal-doc-article" aria-labelledby="portal-doc-title"><div className="portal-doc-breadcrumb">开发文档 <ChevronRight size={12} /> {DOCS.find((doc) => doc.id === activeDoc).title}</div><DocumentContent doc={activeDoc} /><div className="portal-doc-bottom"><ShieldCheck size={15} />参考规格与沙箱能力需区分；实际支持的接口以当前服务和版本化契约为准。</div></article>

      <aside className="portal-code-panel"><div className="portal-code-heading"><span><Terminal size={15} />REFERENCE EXAMPLE</span><button aria-label="复制当前代码示例" onClick={copyCode}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制'}</button></div><div className="portal-language-tabs" role="tablist" aria-label="示例语言">{LANGUAGES.map((item) => <button key={item} role="tab" aria-selected={language === item} className={language === item ? 'portal-language-active' : ''} onClick={() => setLanguage(item)}>{item}</button>)}</div><pre className="portal-code" role="tabpanel" aria-label={`${language} 代码示例`}><code>{code}</code></pre><div className="portal-code-foot"><span className="portal-status-dot portal-status-dot-amber" />示例代码 · 非现成 SDK<br /><span>game-platform.invalid 为文档占位域名</span></div></aside>
    </div>

    <section className="panel portal-simulator"><div className="portal-simulator-head"><div><div className="portal-kicker"><Workflow size={15} /> FLOW EXPLORER</div><h2>把结算流程，走一遍</h2><p>本地流程演示，未连接后端。金额按“币”显示；接口 scale=2，每币 100 最小单位。</p></div><span className="portal-pill portal-pill-amber">{live ? '生产设计预览' : '仅浏览器内模拟'}</span></div><div className="portal-simulator-controls"><label className="portal-scenario-field"><span>演示场景</span><select value={scenarioId} disabled={running || live} onChange={(event) => changeScenario(event.target.value)}>{SCENARIOS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p>{SCENARIOS.find((item) => item.id === scenarioId).caption}</p><button className="button button-ghost" disabled={live} onClick={reset}><RefreshCcw size={15} />重置</button><button className="button button-primary" disabled={live || running} onClick={runDemo}>{running ? <CircleDashed size={16} className="portal-spin" /> : <Play size={15} />}{running ? '演示中…' : '运行本地演示'}</button></div>
      <div className="portal-simulator-body"><div className="portal-timeline" aria-label="本地流程步骤">{scenario.steps.map((step, index) => { const done = index < visibleCompleted; const current = running && !live && simulationEnvironment === environment && index === visibleCompleted; return <div key={`${scenarioId}-${index}`} className={`portal-timeline-row ${done ? 'portal-timeline-done' : ''} ${current ? 'portal-timeline-current' : ''}`}><span className={`portal-timeline-node ${done && step.tone === 'warning' ? 'portal-timeline-warning' : ''}`}>{done ? (step.tone === 'warning' ? <TriangleAlert size={14} /> : <Check size={14} />) : <span>{String(index + 1).padStart(2, '0')}</span>}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div><span className="portal-timeline-tag">{done ? (step.tone === 'warning' ? '异常分支' : '已演示') : current ? '进行中' : '等待'}</span></div>; })}</div>
        <div className="portal-ledger-preview"><div className="portal-ledger-title"><span>模拟余额快照 · 币</span><span>GOLD · SCALE 2</span></div><div className="portal-ledger-account"><span className="portal-player-avatar">A</span><div><span>玩家 A · 可用</span><strong>{balance.a.toLocaleString('en-US')}</strong></div><small>冻结 {balance.holdA}</small></div><div className="portal-ledger-account"><span className="portal-player-avatar portal-player-b">B</span><div><span>玩家 B · 可用</span><strong>{balance.b.toLocaleString('en-US')}</strong></div><small>冻结 {balance.holdB}</small></div><div className="portal-ledger-totals"><div><span>待分配奖池</span><strong>{balance.pool}</strong></div><div><span>服务费账户</span><strong>{balance.fee}</strong></div></div><div className={`portal-ledger-message ${finished ? 'portal-ledger-message-done' : ''}`}>{finished ? <CheckCircle2 size={16} /> : <ShieldCheck size={16} />}<p>{finished ? scenario.result : '每步显示已确认状态；超时期间保留上次确认余额，随后查单恢复。'}</p></div></div>
      </div><div className="portal-simulator-footer" role="status" aria-live="polite"><span className={`portal-status-dot ${finished ? '' : 'portal-status-dot-amber'}`} />{feedback || (live ? '生产预览不允许运行模拟。真实接口验收尚未执行。' : running ? '正在浏览器内播放预设流程，没有发送网络请求。' : '准备就绪。这里不会连接任何钱包，也不会生成真实验收报告。')}</div>
    </section>
  </div>;
}

function DocumentContent({ doc }) {
  if (doc === 'quickstart') return <div className="portal-doc-body"><span className="portal-doc-overline">01 / START BUILDING</span><h2 id="portal-doc-title">第一局，从这里开始。</h2><p className="portal-doc-lead">一次服务端接入，让你的 App 使用统一的游戏身份、钱包与结算协议。</p><div className="portal-inline-callout"><ShieldCheck size={18} /><p><strong>首期只使用 seamless 主钱包。</strong>合作方是可花余额的唯一主账；原子钱包能力达标后，才能正式接入。</p></div><h3>四步建立完整链路</h3><ol className="portal-doc-numbered"><li><span>01</span><div><strong>创建 App，隔离测试环境</strong><p>设置游戏授权、币种、钱包范围与回调地址。示例密钥不能访问生产。</p></div></li><li><span>02</span><div><strong>由 App 后端申请会话</strong><p>平台从鉴权密钥识别 App；用户编号只来自已登录的服务端。</p></div></li><li><span>03</span><div><strong>在 WebView 兑换启动码</strong><p>一次性启动码建议 60 秒有效。客户端不持有长期密钥，也不决定余额。</p></div></li><li><span>04</span><div><strong>完成对局，再验证账务</strong><p>冻结 → 成局捕获 → 服务端判定 → 原子结算。重复、超时、取消都必须可恢复。</p></div></li></ol><div className="portal-request-chip"><span>POST</span><code>/v1/sessions</code><small>协议草案</small></div><p className="portal-doc-small">当前提供本地沙箱、H5 SDK 和 Node 客户端；右侧是其他语言的协议参考。完整启动步骤见阶段 F 教程。</p></div>;
  if (doc === 'launch') return <div className="portal-doc-body"><span className="portal-doc-overline">02 / GAME SESSION</span><h2 id="portal-doc-title">安全进入，可靠重连。</h2><p className="portal-doc-lead">启动一个游戏会话，不等于提交入场扣款。金币授权在玩家确认参赛之后执行。</p><h3>会话里有哪些边界</h3><div className="portal-definition-list"><div><code>external_user_id</code><p>按合作方 + App 映射用户；同名编号不会跨 App 合并。</p></div><div><code>game_id</code><p>必须位于该 App 的游戏授权列表，客户端不能越权切换。</p></div><div><code>launch_code</code><p>短期、一次性使用；过期后由 App 后端重新申请。</p></div><div><code>session_id</code><p>连接用户、App、环境与对局；重连恢复原座位，不再扣一次入场费。</p></div></div><h3>宿主与游戏各自负责什么</h3><p>WebView 示例负责加载、返回、安全区、音频与宿主消息。玩家动作送到游戏服务端校验；客户端的“胜利动画结束”不是派奖指令。</p><div className="portal-inline-callout"><LockKeyhole size={18} /><p>令牌要校验发行方、接收方、算法与用途。WebView 桥接只接受允许来源；长期密钥禁止进入 App 包与前端代码。</p></div><p className="portal-doc-small">语言与显示方向可影响 UI；租户、钱包范围、数学版本由服务端配置决定。</p></div>;
  if (doc === 'wallet') return <div className="portal-doc-body"><span className="portal-doc-overline">03 / WALLET CONTRACT</span><h2 id="portal-doc-title">一份余额，一次业务效果。</h2><p className="portal-doc-lead">游戏冻结与送礼共用同一账本。冻结金币不可再次消费或转赠。</p><div className="portal-doc-table-wrap"><table className="portal-doc-table"><thead><tr><th>能力</th><th>必须保证</th></tr></thead><tbody>{[['GetBalance', '可用、冻结与账本版本'], ['Reserve', '原子检查余额并冻结'], ['CaptureRound', '批量捕获；全部成功才开局'], ['Release', '取消留痕，拒绝迟到冻结'], ['SettleRound', '奖励与费用批量原子入账'], ['GetOperation', '按原业务号查询未知结果']].map(([name, value]) => <tr key={name}><td><code>{name}</code></td><td>{value}</td></tr>)}</tbody></table></div><h3>幂等是账本能力</h3><p>同业务号、同参数返回原结果；同号不同参数拒绝。分录与幂等记录在同一事务提交，不能只靠短期缓存。金额使用整数最小单位的字符串；本例 scale=2，100 币传 "10000"。钱包写命令的 operation_id 等于原 request_id。</p><div className="portal-inline-callout"><Wallet size={18} /><p><strong>200 = 190 + 10</strong><br />双人各 100、示例费率 5%。奖励包含本金，冠军净增加 90；作废时全额返还，费用为零。</p></div><h3>概率游戏单独承担赔付</h3><p>先预授权投注资金与完整周期派彩责任，经 accept 原子锁定责任后，再受理、固定并持久化数学结果。结算失败沿原订单恢复，不能重抽。派奖预算与 PvP 奖池分开，虚拟币分录不等于商业现金收入。</p><p className="portal-doc-small">98% / 99% 为沙箱候选统计目标，尚未完成正式数学认证；修改显示数字不能替代模型验证。子钱包属于后续兼容路线。</p></div>;
  if (doc === 'signature') return <div className="portal-doc-body"><span className="portal-doc-overline">04 / AUTHENTICATION</span><h2 id="portal-doc-title">每一次请求，都有来源。</h2><p className="portal-doc-lead">服务端签名绑定请求内容，密钥按 App、环境与请求方向隔离。</p><h3>固定待签名内容</h3><pre className="portal-inline-code">{'GP-HMAC-SHA256-V1\nDIRECTION\nKEY_ID\nTIMESTAMP\nNONCE\nREQUEST_ID\nUPPERCASE_METHOD\nTARGET_PATH\nSHA256(RAW_BODY)'}</pre><p>以上 9 行用 LF 连接，末尾没有换行。先 Base64 解码密钥，再以 HMAC-SHA256 签名。原始请求体按 UTF-8 计算，发送时不得重新序列化；V1 路径没有 query。</p><div className="portal-definition-list"><div><code>timestamp / nonce</code><p>时间差不超过 300 秒；nonce 为 32 位小写十六进制。重试换 nonce 与时间，request_id 和原始 body 保持不变。</p></div><div><code>key_id</code><p>用于选择已配置密钥；轮换需明确生效与重叠窗口。</p></div><div><code>raw body</code><p>接收后先保留原始报文验签，再解析业务字段。</p></div></div><div className="portal-inline-callout"><KeyRound size={18} /><p>右侧为原生语言示例，不是现成 SDK。X-GP-Key-Id、Direction、Timestamp、Nonce、Request-Id、Signature 六个头均使用 X-GP- 前缀；签名值以 v1= 开头。固定向量见完整接入指南。</p></div></div>;
  if (doc === 'errors') return <div className="portal-doc-body"><span className="portal-doc-overline">05 / RECOVERY</span><h2 id="portal-doc-title">超时，是未知，不是失败。</h2><p className="portal-doc-lead">恢复时沿用原业务号、原对局和原结果，不创造第二笔扣款或奖励。</p><div className="portal-definition-list"><div><code>INSUFFICIENT_FUNDS</code><p>确定拒绝。玩家不占有效席位，不开局；释放需要取消的其他冻结。</p></div><div><code>PENDING / TIMEOUT</code><p>结果未知。查原 operation_id；不得当作“未扣款”换一个编号重发。</p></div><div><code>IDEMPOTENCY_CONFLICT</code><p>同号参数不一致。停止执行、记录差异，不覆盖旧分录。</p></div><div><code>SIGNATURE_INVALID / SCOPE_FORBIDDEN</code><p>检查 App、环境、密钥与对象范围。禁止通过换租户参数绕过。</p></div></div><h3>钱包命令与事件分开</h3><p>钱包命令改变账本；事件只通知统计和展示。事件的 request_id 等于 event_id；其中 operation_id 引用原业务号。按 event_id 去重，允许乱序，通过对象版本或查单恢复权威状态。</p><div className="portal-inline-callout portal-inline-callout-amber"><TriangleAlert size={18} /><p>钱包暂不可用时，比赛可显示“结果已确定，奖金到账中”。通知重试结束并不取消平台对该笔奖励的追踪责任。</p></div></div>;
  return <div className="portal-doc-body"><span className="portal-doc-overline">06 / ACCEPTANCE</span><h2 id="portal-doc-title">接通，要看完整链路。</h2><p className="portal-doc-lead">打开一个 H5 页面不是接入完成。需使用两个独立测试 App，验证真实服务端与 WebView。</p><div className="portal-acceptance-list">{['真实登录身份 → 一次性启动码 → 正确 App 与用户', '冻结期间送礼不能花掉被冻结的余额', 'A / B 各 1,000，正常结算为 1,090 / 900，费用 10', '扣款、派奖重复 10 次，最终分录与余额不变', '成功后丢响应：用原业务号查单恢复', '未成局取消：全额释放，服务费为零', '跨 App 与跨环境查询订单均被拒绝', '概率结果先持久化，结算重试不重新开奖'].map((text, index) => <div key={text}><span>{String(index + 1).padStart(2, '0')}</span><p>{text}</p><small>按接入报告核验</small></div>)}</div><div className="portal-inline-callout"><ClipboardCheck size={18} /><p>下方工具只演示预设状态变化，没有对接口、设备或钱包做任何真实验证。上方接入检查会真实执行并保存报告；真机及生产验收还需单独完成。</p></div></div>;
}
