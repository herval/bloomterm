import { FN, FUNCTIONS, type ViewProps } from '../functions.ts';

const KEYS: Array<[string, string]> = [
  ['⌘K / Ctrl+K', 'search tickers, company names, pages and actions; mnemonics work there too'],
  ['⌘↵ in ⌘K', 'ask your agent what you typed'],
  ['⌘J / Ctrl+J', 'open or close Ask beside the page'],
  ['any letter, /', 'on a page: search; in the terminal: type a command'],
  ['Enter', 'GO'],
  ['a question, Enter', 'ASK answers it (start with ? to force a question)'],
  ['Esc', 'clear the line, then back'],
  ['↑ ↓', "this panel's command history"],
  ['Tab', 'complete a function name'],
  ['Ctrl+1…4', 'focus panel N'],
  ['Ctrl+M', 'maximize / restore the panel'],
  ['drag a divider', 'resize the panels (double-click evens it out)'],
  ['F1', 'help for the current function'],
  ['3 <GO>', 'open row 3 of a list'],
];

export default function Help({ panel, nav, drill }: ViewProps) {
  const which = panel.args[0]?.toUpperCase();
  const one = which ? FN[which] : undefined;
  drill.current = (row) => {
    const f = FUNCTIONS[row - 1];
    if (f) nav.open({ fn: 'HELP', args: [f.mnemonic] });
  };

  if (one) {
    return (
      <div className="scroll help">
        <div className="section">
          {one.mnemonic} · {one.title}
        </div>
        <p>{one.help}</p>
        <p>
          <span className="muted">Example:</span> <code>{one.usage}</code>
        </p>
        <p className="muted">{one.scope === 'security' ? 'Acts on the panel’s security; linked panels follow it.' : 'Not tied to a security.'}</p>
      </div>
    );
  }

  return (
    <div className="scroll help">
      <div className="section">Commands</div>
      <p>
        <code>[security] [FUNCTION] [args] &lt;GO&gt;</code>
        <span className="muted"> · e.g. </span>
        <code>AAPL GP 1Y</code>, <code>petr4</code>, <code>btc gp 5y</code>, <code>W ADD vale3</code>, <code>LOGIN b3</code>
      </p>
      <p className="muted">
        Securities: AAPL US Equity · PETR4 BZ Equity · USDBRL Curncy · BTCUSD Crypto · IBOV Index. Type as little as resolves: aapl, petr4, usdbrl, btc.
      </p>
      <table className="grid">
        <tbody>
          {FUNCTIONS.map((f, i) => (
            <tr key={f.mnemonic} onClick={() => nav.open({ fn: 'HELP', args: [f.mnemonic] })}>
              <td className="n">{i + 1}</td>
              <td className="sec">{f.mnemonic}</td>
              <td>{f.title}</td>
              <td className="muted">{f.help}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="section">Keys</div>
      <table className="grid">
        <tbody>
          {KEYS.map(([k, v]) => (
            <tr key={k}>
              <td className="sec">{k}</td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Credits />
    </div>
  );
}

/** Who made what bloomterm stands on. TradingView's license asks for this notice and the link. */
function Credits() {
  return (
    <>
      <div className="section">About</div>
      <p className="muted">
        bloomterm is open source under the MIT License. It isn't investment advice, and it isn't affiliated with any exchange, bank, broker or data
        provider.
      </p>
      <p className="muted">
        Charts: TradingView Lightweight Charts™, Copyright © 2025 TradingView, Inc.,{' '}
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          tradingview.com
        </a>
        . Fonts: Geist and Geist Mono (SIL Open Font License). Spreadsheets: SheetJS.
      </p>
    </>
  );
}
