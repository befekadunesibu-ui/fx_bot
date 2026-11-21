import { useEffect, useMemo, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { authenticateTelegram, setupTelegramWebApp } from './telegram';
import { apiMarketDataProvider, getMarketProviderStatus, type MarketInstrument, type MarketProviderStatus, type MarketSeries, type Timeframe } from './marketData';
import { closePaperPosition, getAnalysis, getPaperData, openPaperPosition, startPaperEngine, stopPaperEngine, updateStrategyConfig, type AnalysisResult, type PaperPosition, type StrategyConfig } from './phase2Api';
import {
  BarChart3, Bell, Bot, ChevronRight, CircleDollarSign, LayoutDashboard,
  Home, Moon, RefreshCw, ShieldCheck, Sparkles, TrendingUp, X,
} from 'lucide-react';

type NavItem = { label: string; path: string; icon: typeof LayoutDashboard };

const navItems: NavItem[] = [
  { label: 'Dashboard', path: '/', icon: LayoutDashboard },
  { label: 'Market Watch', path: '/market-watch', icon: BarChart3 },
  { label: 'AI Analyst', path: '/ai-analyst', icon: Bot },
  { label: 'Paper Trading', path: '/paper-trading', icon: CircleDollarSign },
];

function App() {
  const [telegramUser, setTelegramUser] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    authenticateTelegram()
      .then(setTelegramUser)
      .catch(() => setTelegramUser(null));
  }, []);

  useEffect(() => setupTelegramWebApp(() => navigate('/'), location.pathname !== '/'), [location.pathname, navigate]);

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><strong>{navItems.find((item) => item.path === location.pathname)?.label ?? 'Dashboard'}</strong></div>
          <div className="topbar-actions"><span className="demo-pill"><span /> {telegramUser ? `Welcome, ${telegramUser}` : 'Demo mode'}</span><button className="icon-button"><Bell size={18} /></button><div className="avatar">FD</div></div>
        </header>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/market-watch" element={<MarketWatch />} />
          <Route path="/ai-analyst" element={<AIAnalyst />} />
          <Route path="/paper-trading" element={<PaperTrading />} />
        </Routes>
        <MobileBottomNav />
      </main>
    </div>
  );
}

function MobileBottomNav() {
  const items = [
    { label: 'Dashboard', path: '/', icon: Home },
    { label: 'Markets', path: '/market-watch', icon: BarChart3 },
    { label: 'Paper Trading', path: '/paper-trading', icon: CircleDollarSign },
    { label: 'AI Analyst', path: '/ai-analyst', icon: Bot },
  ];

  return <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
    {items.map(({ label, path, icon: Icon }) => <NavLink key={path} to={path} end={path === '/'} className={({ isActive }) => isActive ? 'mobile-nav-item active' : 'mobile-nav-item'}>
      <Icon size={19} strokeWidth={2} /><span>{label}</span>
    </NavLink>)}
  </nav>;
}

function Sidebar() {
  return <aside className="sidebar">
    <div className="brand"><div className="brand-mark"><Sparkles size={17} /></div><div><strong>FD Forex AI</strong><small>Research terminal</small></div><button className="icon-button close-menu" aria-label="Close menu"><X size={18} /></button></div>
    <div className="workspace-card"><div className="workspace-icon"><ShieldCheck size={17} /></div><div><span>Private workspace</span><strong>Personal account</strong></div><ChevronRight size={16} /></div>
    <nav>{navItems.map(({ label, path, icon: Icon }) => <NavLink key={path} to={path} end={path === '/'} className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}><Icon size={18} /><span>{label}</span></NavLink>)}</nav>
    <div className="sidebar-footer"><div className="footer-line"><Moon size={16} /> <span>Dark theme</span><div className="toggle on"><i /></div></div><small>v0.2.0 · Research and paper simulation</small></div>
  </aside>;
}

function Dashboard() {
  const [paper, setPaper] = useState<Awaited<ReturnType<typeof getPaperData>> | null>(null);
  const [draft, setDraft] = useState<StrategyConfig | null>(null);
  const [busy, setBusy] = useState<'start' | 'stop' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const next = await getPaperData();
      setPaper(next);
      setDraft((current) => current ?? next.strategy);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Paper account is unavailable.');
    }
  };
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await getPaperData();
        if (active) {
          setPaper(next);
          setDraft((current) => current ?? next.strategy);
          setError(null);
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Paper account is unavailable.');
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  const applySettings = (settings: Awaited<ReturnType<typeof startPaperEngine>>['settings']) => {
    setPaper((current) => current ? {
      ...current,
      settings,
      strategy: settings.strategyConfig,
      engine: { ...current.engine, status: settings.engineStatus, updatedAt: new Date().toISOString() },
    } : current);
    setDraft(settings.strategyConfig);
  };
  const start = async () => {
    setBusy('start'); setError(null);
    try { applySettings((await startPaperEngine()).settings); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The bot could not be started.'); }
    finally { setBusy(null); }
  };
  const stop = async () => {
    setBusy('stop'); setError(null);
    try { applySettings((await stopPaperEngine()).settings); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The bot could not be stopped.'); }
    finally { setBusy(null); }
  };
  const save = async () => {
    if (!draft) return;
    setBusy('save'); setError(null);
    try { applySettings((await updateStrategyConfig(draft)).settings); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Strategy settings could not be saved.'); }
    finally { setBusy(null); }
  };
  const updateDraft = (values: Partial<StrategyConfig>) => setDraft((current) => current ? { ...current, ...values } : current);
  const toggleInstrument = (instrument: string) => {
    if (!draft) return;
    const instruments = draft.instruments.includes(instrument)
      ? draft.instruments.filter((item) => item !== instrument)
      : [...draft.instruments, instrument];
    if (instruments.length > 0) updateDraft({ instruments });
  };
  const running = paper?.engine.status === 'RUNNING';
  const strategyDirty = Boolean(paper && draft && JSON.stringify(draft) !== JSON.stringify(paper.strategy));
  const displayedDecision = running ? paper?.latestDecision?.decision ?? 'WAIT' : 'WAIT';
  const displayedReason = running
    ? paper?.latestDecision?.reason ?? 'No strategy decision recorded. New entries require verified market and strategy data.'
    : 'Bot is not running. No new simulated entries are being evaluated.';
  const methods: Array<{ key: keyof StrategyConfig['analysisMethods']; label: string }> = [
    { key: 'rsi', label: 'RSI' },
    { key: 'macd', label: 'MACD' },
    { key: 'movingAverages', label: 'Moving averages' },
    { key: 'supportResistance', label: 'Support / resistance' },
    { key: 'candlestickPatterns', label: 'Candlestick patterns' },
  ];

  return <div className="page dashboard-page">
    <section className="page-heading">
      <div><p className="eyebrow">PAPER TRADING · SIMULATED ONLY</p><h1>FD Forex <span>AI.</span></h1><p className="muted">A compact view of your virtual account and strategy.</p></div>
      <div className={`bot-status ${running ? 'running' : paper ? 'stopped' : ''}`}><span /> BOT {paper?.engine.status ?? 'STATUS UNAVAILABLE'}</div>
    </section>
    {error && <div className="panel dashboard-error"><strong>Action or data unavailable</strong><p>{error}</p></div>}
    {!paper && !error && <div className="panel market-state"><div className="loading-spinner" /><p className="muted">Loading authenticated paper account...</p></div>}
    {paper && <>
      <section className="metric-grid dashboard-metrics">
        <Metric label="Virtual balance" value={`$${paper.account.balance.toFixed(2)}`} change="Paper account" />
        <Metric label="Simulated P/L" value={`$${(paper.account.realizedPnl + paper.account.unrealizedPnl).toFixed(2)}`} change={`Realized ${paper.account.realizedPnl.toFixed(2)} · Open ${paper.account.unrealizedPnl.toFixed(2)}`} positive={paper.account.realizedPnl + paper.account.unrealizedPnl >= 0} />
        <Metric label="Open simulated positions" value={String(paper.positions.length)} change={`Maximum ${paper.strategy.maxOpenPositions}`} />
      </section>
      <section className="panel dashboard-bot">
        <div><strong>{paper.strategy.name}</strong><p>{paper.strategy.tradingStyle} · {paper.strategy.entryTimeframe} · {paper.strategy.instruments.map((instrument) => instrument.replace('/', '')).join(', ')}</p></div>
        <div className="dashboard-decision"><span>Latest decision</span><strong>{displayedDecision}</strong><small>{displayedReason}</small></div>
        <div className="dashboard-actions">
          <button className="primary-button start-button" onClick={start} disabled={busy !== null || running || strategyDirty}>{busy === 'start' ? 'CHECKING DATA...' : strategyDirty ? 'SAVE STRATEGY FIRST' : 'START BOT'}</button>
          <button className="secondary-button stop-button" onClick={stop} disabled={busy !== null || !running}>{busy === 'stop' ? 'STOPPING...' : 'STOP BOT'}</button>
        </div>
        <p className="muted dashboard-boundary">{paper.marketProvider.provider}: {paper.marketProvider.connected ? 'connected' : 'unavailable'} · Telegram app may close while the backend scheduler runs. No real orders are sent.</p>
      </section>
      {draft && <section className="panel customize-card">
        <div className="panel-heading"><div><p className="eyebrow">PAPER STRATEGY</p><h2>Customize Strategy</h2><p>Changes are saved to your authenticated account. Stop the bot before editing.</p></div></div>
        <fieldset disabled={running || busy !== null}>
          <div className="strategy-form-grid">
            <label>Trading style<select value={draft.tradingStyle} onChange={(event) => updateDraft({ tradingStyle: event.target.value as StrategyConfig['tradingStyle'] })}><option value="SCALP">Scalp</option><option value="DAY">Day</option><option value="SWING">Swing</option></select></label>
            <label>Timeframe<select value={draft.entryTimeframe} onChange={(event) => updateDraft({ entryTimeframe: event.target.value, analysisTimeframe: event.target.value })}>{[['5min', '5 minutes'], ['15min', '15 minutes'], ['30min', '30 minutes'], ['1h', '1 hour'], ['4h', '4 hours']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Minimum confidence ({draft.minimumConfidence}%)<input type="range" min="85" max="100" step="1" value={draft.minimumConfidence} onChange={(event) => updateDraft({ minimumConfidence: Number(event.target.value) })} /></label>
            <label>Maximum open positions<select value={draft.maxOpenPositions} onChange={(event) => updateDraft({ maxOpenPositions: Number(event.target.value) })}>{[1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label>Simulated risk per position<select value={draft.riskPerPosition} onChange={(event) => updateDraft({ riskPerPosition: Number(event.target.value) })}>{[[0.001, '0.1%'], [0.002, '0.2%'], [0.003, '0.3%'], [0.004, '0.4%'], [0.005, '0.5%']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          <div className="strategy-options"><strong>Instruments</strong><div className="strategy-checks">{['XAU/USD', 'GBP/USD'].map((instrument) => <label key={instrument}><input type="checkbox" checked={draft.instruments.includes(instrument)} onChange={() => toggleInstrument(instrument)} />{instrument.replace('/', '')}</label>)}</div></div>
          <div className="strategy-options"><strong>Analysis methods</strong><div className="strategy-checks">{methods.map(({ key, label }) => <label key={key}><input type="checkbox" checked={draft.analysisMethods[key]} onChange={(event) => updateDraft({ analysisMethods: { ...draft.analysisMethods, [key]: event.target.checked } })} />{label}</label>)}</div></div>
        </fieldset>
        <div className="strategy-save-row"><span className="muted">{running ? 'Stop the bot before changing its strategy.' : 'The 2% daily loss limit and minimum 1:2 reward-to-risk remain enforced.'}</span><button className="primary-button" onClick={save} disabled={busy !== null || running}>{busy === 'save' ? 'SAVING...' : 'SAVE STRATEGY'}</button></div>
      </section>}
    </>}
  </div>;
}

function Metric({ label, value, change, positive }: { label: string; value: string; change: string; positive?: boolean }) {
  return <div className="panel metric"><span className="muted">{label}</span><strong>{value}</strong><small className={positive ? 'positive' : 'muted'}>{positive && <TrendingUp size={12} />}{change}</small></div>;
}

function MarketWatch() {
  const [instruments, setInstruments] = useState<MarketInstrument[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState('XAU/USD');
  const [timeframe, setTimeframe] = useState<Timeframe>('1D');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [providerStatus, setProviderStatus] = useState<MarketProviderStatus | null>(null);
  const [chartValues, setChartValues] = useState<MarketSeries>({ values: [], status: 'unavailable', fetchedAt: '' });
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);

  const loadMarketData = () => {
    setLoading(true);
    setError(null);
    Promise.all([apiMarketDataProvider.getInstruments(), getMarketProviderStatus()])
      .then(([nextInstruments, status]) => { setInstruments(nextInstruments); setProviderStatus(status); })
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : 'Market data could not be loaded. Please try again.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadMarketData();
  }, []);

  const selectedInstrument = useMemo(
    () => instruments.find((instrument) => instrument.symbol === selectedSymbol) ?? instruments[0],
    [instruments, selectedSymbol],
  );

  useEffect(() => {
    if (!selectedInstrument) return;
    setChartLoading(true);
    setChartError(null);
    apiMarketDataProvider.getSeries(selectedInstrument.symbol, timeframe)
      .then(setChartValues)
      .catch((loadError: unknown) => {
        setChartValues({ values: [], status: 'unavailable', fetchedAt: '' });
        setChartError(loadError instanceof Error ? loadError.message : 'Historical data could not be loaded.');
      })
      .finally(() => setChartLoading(false));
  }, [selectedInstrument, timeframe]);

  return <div className="page market-page">
    <section className="page-heading">
      <div>
        <p className="eyebrow">MARKET RESEARCH</p>
        <h1>Market <span>Watch.</span></h1>
        <p className="muted">Provider-sourced quotes and historical context for your watchlist.</p>
      </div>
      <div className={providerStatus?.connected ? 'demo-source active' : 'demo-source'}><span /> {providerStatus?.provider ?? 'Market provider'} · {providerStatus?.connected ? 'Connected' : 'Disconnected'}</div>
    </section>
    {providerStatus && <div className="notice market-notice"><div className="notice-icon"><BarChart3 size={17} /></div><div><strong>{providerStatus.provider} connection</strong><p>{providerStatus.connected ? `Available symbols: ${providerStatus.availableSymbols.join(', ') || 'none reported'}.` : providerStatus.lastError ?? 'Provider is disconnected.'} {providerStatus.lastSuccessfulUpdate ? `Last successful update: ${new Date(providerStatus.lastSuccessfulUpdate).toLocaleString()}.` : ''}</p></div></div>}
    <div className="notice market-notice">
      <div className="notice-icon"><BarChart3 size={17} /></div>
      <div><strong>Educational market research</strong><p>Quotes are sourced from Twelve Data when available. They may be delayed or stale; no account access or trading execution is connected.</p></div>
    </div>
    {loading && <div className="panel market-state"><div className="loading-spinner" /><strong>Loading market watch</strong><p className="muted">Requesting provider data...</p></div>}
    {!loading && error && <div className="panel market-state"><strong>Market data unavailable</strong><p className="muted">{error}</p><button className="secondary-button" onClick={loadMarketData}><RefreshCw size={14} /> Retry</button></div>}
    {!loading && !error && instruments.length === 0 && <div className="panel market-state"><strong>No instruments available</strong><p className="muted">The market data provider returned an empty watchlist.</p></div>}
    {!loading && !error && instruments.length > 0 && selectedInstrument && <MarketWatchContent
      instruments={instruments}
      selectedInstrument={selectedInstrument}
      selectedSymbol={selectedSymbol}
      onSelect={setSelectedSymbol}
      timeframe={timeframe}
      onTimeframeChange={setTimeframe}
      chartValues={chartValues}
      chartLoading={chartLoading}
      chartError={chartError}
    />}
  </div>;
}

function MarketWatchContent({
  instruments, selectedInstrument, selectedSymbol, onSelect,   timeframe, onTimeframeChange, chartValues, chartLoading, chartError,
}: {
  instruments: MarketInstrument[];
  selectedInstrument: MarketInstrument;
  selectedSymbol: string;
  onSelect: (symbol: string) => void;
  timeframe: Timeframe;
  onTimeframeChange: (timeframe: Timeframe) => void;
  chartValues: MarketSeries;
  chartLoading: boolean;
  chartError: string | null;
}) {
  return <>
    <section className="instrument-grid">
      {instruments.map((instrument, index) => <button
        className={`instrument-card panel ${instrument.symbol === selectedSymbol ? 'selected' : ''}`}
        key={instrument.symbol}
        onClick={() => onSelect(instrument.symbol)}
      >
        <span className="instrument-rank">{index === 0 ? 'PRIMARY' : 'WATCHLIST'}</span>
        <span className="instrument-symbol">{instrument.symbol}</span>
        <span className="instrument-name">{instrument.name}</span>
        <strong>{instrument.price}</strong>
        <span className={instrument.change === null ? 'muted' : instrument.change >= 0 ? 'positive' : 'negative'}>{instrument.change === null ? 'Unavailable' : `${instrument.change >= 0 ? '+' : ''}${instrument.change.toFixed(2)}%`}</span>
        <small><i className={instrument.status === 'live' ? 'status-open' : 'status-closed'} />{instrument.status} · Bid {instrument.bid?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ?? 'Unavailable'} · Ask {instrument.ask?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ?? 'Unavailable'} · Spread {instrument.spread?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ?? 'Unavailable'}</small>
      </button>)}
    </section>
    <section className="panel market-chart-panel">
      <div className="panel-heading market-chart-heading">
        <div><p className="eyebrow">SELECTED INSTRUMENT</p><h2>{selectedInstrument.symbol} <span>{selectedInstrument.name}</span></h2><p>{selectedInstrument.currency} quoted · {selectedInstrument.source} · Observed {selectedInstrument.observedAt ? new Date(selectedInstrument.observedAt).toLocaleString() : 'Unavailable'}</p><p>Bid {selectedInstrument.bid?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ?? 'Unavailable'} · Ask {selectedInstrument.ask?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ?? 'Unavailable'} · Spread {selectedInstrument.spread?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ?? 'Unavailable'}</p></div>
        <div className="timeframe-tabs">{(['1H', '4H', '1D', '1W'] as Timeframe[]).map((option) => <button className={timeframe === option ? 'active' : ''} key={option} onClick={() => onTimeframeChange(option)}>{option}</button>)}</div>
      </div>
      <div className="selected-price"><strong>{selectedInstrument.price}</strong><span className={selectedInstrument.change === null ? 'muted' : selectedInstrument.change >= 0 ? 'positive' : 'negative'}>{selectedInstrument.change === null ? 'Change unavailable' : `${selectedInstrument.change >= 0 ? '+' : ''}${selectedInstrument.change.toFixed(2)}% today`} · {selectedInstrument.status}</span></div>
      {chartLoading && <div className="market-state"><div className="loading-spinner" /><p className="muted">Loading historical candles...</p></div>}
      {!chartLoading && chartError && <div className="market-state"><strong>Historical data unavailable</strong><p className="muted">{chartError}</p></div>}
      {!chartLoading && !chartError && chartValues.values.length === 0 && <div className="market-state"><strong>No historical data available</strong><p className="muted">This instrument or timeframe is unavailable from the configured provider.</p></div>}
      {!chartLoading && !chartError && chartValues.values.length > 0 && <><p className="market-data-status">{chartValues.status === 'stale' ? 'Stale historical data · ' : ''}{selectedInstrument.source} · Updated {new Date(chartValues.fetchedAt).toLocaleTimeString()}</p><MarketChart values={chartValues.values} symbol={selectedInstrument.symbol} /></>}
    </section>
  </>;
}

function MarketChart({ values, symbol }: { values: number[]; symbol: string }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${94 - ((value - min) / range) * 78}`).join(' ');
  const areaPoints = `0,100 ${points} 100,100`;
  return <div className="market-chart" aria-label={`${symbol} historical price chart`}>
    <div className="chart-y market-chart-y"><span>{max.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span><span>{((max + min) / 2).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span><span>{min.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>
    <div className="market-chart-lines"><div className="grid-lines" /><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${symbol} historical chart`}><defs><linearGradient id="market-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#8b5cf6" stopOpacity=".3" /><stop offset="1" stopColor="#8b5cf6" stopOpacity="0" /></linearGradient></defs><polygon points={areaPoints} fill="url(#market-fill)" /><polyline points={points} fill="none" stroke="#a78bfa" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg><div className="chart-x"><span>Start</span><span>Historical</span><span>Latest candle</span></div></div>
  </div>;
}

function AIAnalyst() {
  const [symbol, setSymbol] = useState('XAU/USD');
  const [timeframe, setTimeframe] = useState<Timeframe>('1H');
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explanationError, setExplanationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyze = () => {
    setLoading(true); setError(null);
    getAnalysis(symbol, timeframe).then((result) => {
      setAnalysis(result.analysis); setExplanation(result.explanation); setExplanationError(result.explanationError);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Analysis is unavailable.'))
      .finally(() => setLoading(false));
  };
  return <div className="page">
    <section className="page-heading"><div><p className="eyebrow">DETERMINISTIC TECHNICAL RESEARCH</p><h1>AI <span>Analyst.</span></h1><p className="muted">Technical calculations are produced from the configured market-data provider. Gemini only explains the validated result.</p></div><div className="demo-source"><span /> Educational only</div></section>
    <div className="panel phase-controls"><label>Instrument<select value={symbol} onChange={(event) => setSymbol(event.target.value)}>{['XAU/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY'].map((value) => <option key={value}>{value}</option>)}</select></label><label>Timeframe<select value={timeframe} onChange={(event) => setTimeframe(event.target.value as Timeframe)}>{(['1H', '4H', '1D', '1W'] as Timeframe[]).map((value) => <option key={value}>{value}</option>)}</select></label><button className="primary-button" onClick={analyze} disabled={loading}><Sparkles size={16} /> {loading ? 'Analyzing...' : 'Analyze market'}</button></div>
    {error && <div className="panel market-state"><strong>Analysis unavailable</strong><p className="muted">{error}</p><button className="secondary-button" onClick={analyze}><RefreshCw size={14} /> Retry</button></div>}
    {!loading && !error && !analysis && <div className="panel market-state"><strong>Choose an instrument and analyze</strong><p className="muted">No signals or market facts are generated until verified provider candles are available.</p></div>}
    {analysis && <section className="analysis-grid"><div className="panel analysis-summary"><p className="eyebrow">{analysis.symbol} · {analysis.interval}</p><h2 className={analysis.trend === 'bullish' ? 'positive' : analysis.trend === 'bearish' ? 'negative' : ''}>{analysis.trend.toUpperCase()}</h2><p className="muted">Setup: {analysis.setup} · Condition: {analysis.marketCondition}</p><p className="muted">Source: {analysis.source} · {analysis.freshness} · {new Date(analysis.timestamp).toLocaleString()}</p><div className="indicator-grid">{Object.entries(analysis.indicators).map(([key, value]) => <div key={key}><span>{key}</span><strong>{value.toFixed(5)}</strong></div>)}</div></div><div className="panel reasons-card"><h2>Research context</h2><h3 className="positive">Supporting</h3><ul>{analysis.supportingReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><h3 className="negative">Contradicting</h3><ul>{analysis.contradictingReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>{explanation && <><h3>AI explanation</h3><p className="muted">{explanation}</p></>}{explanationError && <p className="negative">AI explanation unavailable ({explanationError}); deterministic analysis remains valid.</p>}</div></section>}
    <p className="educational-disclaimer">Educational research only. This analysis is not financial advice, has no profit guarantee, and must not be used as an instruction to place real trades.</p>
  </div>;
}

function PaperTrading() {
  const [data, setData] = useState<Awaited<ReturnType<typeof getPaperData>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [symbol, setSymbol] = useState('XAU/USD');
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [quantity, setQuantity] = useState('0.01');
  const [tradeBusy, setTradeBusy] = useState(false);
  const load = () => { setLoading(true); setError(null); getPaperData().then(setData).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Paper account is unavailable.')).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (data?.strategy.instruments.length && !data.strategy.instruments.includes(symbol)) setSymbol(data.strategy.instruments[0]);
  }, [data, symbol]);
  const openPosition = () => {
    const parsedQuantity = Number(quantity);
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) { setError('Enter a position size greater than zero.'); return; }
    if (!window.confirm(`Open a simulated ${side} position on ${symbol}?`)) return;
    setTradeBusy(true); setError(null);
    openPaperPosition(symbol, side, parsedQuantity).then(load).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The simulated position could not be opened.')).finally(() => setTradeBusy(false));
  };
  const closePosition = (position: PaperPosition) => {
    if (!window.confirm(`Close the simulated ${position.side} position on ${position.symbol}?`)) return;
    setTradeBusy(true); setError(null);
    closePaperPosition(position._id).then(load).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The simulated position could not be closed.')).finally(() => setTradeBusy(false));
  };
  return <div className="page"><section className="page-heading"><div><p className="eyebrow">SIMULATED EXECUTION</p><h1>Paper <span>Trading.</span></h1><p className="muted">All entries, exits, balances, spread and slippage are virtual. No broker order is sent.</p></div><div className={data?.engine.status === 'RUNNING' ? 'demo-source active' : 'demo-source'}><span /> Bot {data?.engine.status ?? 'status unavailable'}</div></section>
    <div className="notice"><div className="notice-icon"><CircleDollarSign size={17} /></div><div><strong>Simulation boundary</strong><p>Results are historical/virtual experiments and do not predict real-world returns.</p></div></div>
    {loading && <div className="panel market-state"><div className="loading-spinner" /><strong>Loading paper account</strong></div>}
    {!loading && error && <div className="panel market-state"><strong>Paper trading unavailable</strong><p className="muted">{error}</p><button className="secondary-button" onClick={load}><RefreshCw size={14} /> Retry</button></div>}
    {!loading && data && <><div className="metric-grid"><Metric label="Virtual balance" value={`$${data.account.balance.toFixed(2)}`} change="SIMULATED" /><Metric label="Virtual equity" value={`$${data.account.equity.toFixed(2)}`} change={`Unrealized ${data.account.unrealizedPnl.toFixed(2)}`} positive={data.account.equity >= data.account.balance} /><Metric label="Simulated P&L" value={`$${data.account.realizedPnl.toFixed(2)}`} change="SIMULATED" positive={data.account.realizedPnl >= 0} /><Metric label="Open positions" value={String(data.positions.length)} change={`Max ${data.settings.maxOpenPositions}`} /></div><div className="panel phase-controls paper-trade-form"><strong>Open simulated position</strong><label>Instrument<select value={data.strategy.instruments.includes(symbol) ? symbol : data.strategy.instruments[0]} onChange={(event) => setSymbol(event.target.value)}>{data.strategy.instruments.map((value) => <option key={value}>{value}</option>)}</select></label><label>Side<select value={side} onChange={(event) => setSide(event.target.value as 'long' | 'short')}><option value="long">Buy / Long</option><option value="short">Sell / Short</option></select></label><label>Position size<input type="number" min="0.0001" step="0.0001" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label><button className="primary-button" onClick={openPosition} disabled={tradeBusy}>{tradeBusy ? 'Processing...' : 'Confirm simulated trade'}</button><span className="muted">The saved FD strategy and risk limits validate every simulated entry.</span></div><section className="content-grid"><div className="panel"><div className="panel-heading"><div><h2>Open simulated positions</h2><p>Current values are provider-priced and virtual</p></div></div>{data.positions.length === 0 ? <p className="muted empty-copy">No open simulated positions.</p> : <div className="table-list">{data.positions.map((position) => <div className="table-row paper-position-row" key={position._id}><strong>{position.symbol}</strong><span>{position.side} · {position.quantity.toFixed(4)}</span><span>Entry {position.entryPrice.toFixed(5)} · Current {position.currentPrice.toFixed(5)}</span><span>SL {position.stopLoss.toFixed(5)} · TP {position.takeProfit.toFixed(5)}</span><button className="secondary-button" onClick={() => closePosition(position)} disabled={tradeBusy}>Close simulated</button></div>)}</div>}</div><div className="panel"><div className="panel-heading"><div><h2>Trading history</h2><p>Closed simulated trades</p></div></div>{data.trades.length === 0 ? <p className="muted empty-copy">No simulated trades yet.</p> : <div className="table-list">{data.trades.slice(0, 10).map((trade, index) => <div className="table-row" key={`${trade.symbol}-${trade.closedAt}-${index}`}><strong>{trade.symbol}</strong><span>{trade.side}</span><span className={trade.pnl >= 0 ? 'positive' : 'negative'}>{trade.pnl.toFixed(2)}</span><span>{trade.reason}</span></div>)}</div>}</div></section></>}
  </div>;
}

export default App;
