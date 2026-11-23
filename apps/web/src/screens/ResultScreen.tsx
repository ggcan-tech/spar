import type { FighterView, MatchView } from '@spar/protocol';
import '../render/fight.css';

export interface ResultScreenProps {
  result: MatchView;
  localPlayer: 0 | 1;
  onHome: () => void;
  onRematch: () => void;
}

function pct(landed: number, thrown: number): string {
  if (thrown <= 0) return '—';
  return `${Math.round((landed / thrown) * 100)}%`;
}

function methodText(r: MatchView): string {
  switch (r.method) {
    case 'KO':
      return `Knockout · round ${r.round}`;
    case 'TKO':
      return `Technical knockout · round ${r.round}`;
    case 'DECISION':
      return r.winner === 'DRAW' ? 'Draw on the scorecards' : 'Decision · scorecards';
    default:
      return r.state === 'OVER' ? 'Match over' : 'Unfinished';
  }
}

export function ResultScreen({ result, localPlayer, onHome, onRematch }: ResultScreenProps) {
  const opp = (1 - localPlayer) as 0 | 1;
  const me: FighterView = result.fighters[localPlayer];
  const them: FighterView = result.fighters[opp];
  const won = result.winner === localPlayer;
  const draw = result.winner === 'DRAW';
  const title = draw ? 'DRAW' : won ? 'YOU WIN' : result.winner === null ? 'NO RESULT' : 'YOU LOSE';
  const titleClass = draw || result.winner === null ? 'rs__title--draw' : won ? 'rs__title--win' : 'rs__title--lose';

  const rounds = Math.max(result.scores[0].length, result.scores[1].length);
  const myScores = result.scores[localPlayer];
  const theirScores = result.scores[opp];
  const myTotal = myScores.reduce((s, v) => s + v, 0);
  const theirTotal = theirScores.reduce((s, v) => s + v, 0);

  const statRows: Array<[string, string, string]> = [
    ['Thrown', String(me.thrown), String(them.thrown)],
    ['Landed', String(me.landed), String(them.landed)],
    ['Accuracy', pct(me.landed, me.thrown), pct(them.landed, them.thrown)],
    ['Knockdowns (final round)', String(me.knockdowns), String(them.knockdowns)],
    ['HP left', String(Math.max(0, me.hp)), String(Math.max(0, them.hp))],
    ['Stamina left', String(Math.max(0, me.stamina)), String(Math.max(0, them.stamina))],
  ];

  return (
    <div className="rs">
      <div className="rs__head">
        <h1 className={`rs__title ${titleClass}`}>{title}</h1>
        <div className="rs__method">{methodText(result)}</div>
      </div>

      <div className="rs__grid">
        <section className="rs__panel">
          <h3>Judges&apos; scorecards</h3>
          {rounds === 0 ? (
            <div className="os__meta">No completed rounds.</div>
          ) : (
            <table className="rs__table">
              <thead>
                <tr>
                  <th>Round</th>
                  <th className="num rs__you">YOU</th>
                  <th className="num rs__them">THEM</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: rounds }, (_, i) => {
                  const a = myScores[i] ?? 0;
                  const b = theirScores[i] ?? 0;
                  return (
                    <tr key={i}>
                      <td>R{i + 1}</td>
                      <td className={`num${a > b ? ' rs__win' : ''}`}>{a}</td>
                      <td className={`num${b > a ? ' rs__win' : ''}`}>{b}</td>
                    </tr>
                  );
                })}
                <tr className="total">
                  <td>Total</td>
                  <td className={`num${myTotal > theirTotal ? ' rs__win' : ''}`}>{myTotal}</td>
                  <td className={`num${theirTotal > myTotal ? ' rs__win' : ''}`}>{theirTotal}</td>
                </tr>
              </tbody>
            </table>
          )}
        </section>

        <section className="rs__panel">
          <h3>Punch stats</h3>
          <table className="rs__table">
            <thead>
              <tr>
                <th />
                <th className="num rs__you">YOU</th>
                <th className="num rs__them">THEM</th>
              </tr>
            </thead>
            <tbody>
              {statRows.map(([label, a, b]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num">{a}</td>
                  <td className="num">{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <div className="rs__actions">
        <button type="button" className="fs__btn fs__btn--red fs__btn--lg" onClick={onRematch}>
          Rematch
        </button>
        <button type="button" className="fs__btn fs__btn--lg" onClick={onHome}>
          Home
        </button>
      </div>
    </div>
  );
}
