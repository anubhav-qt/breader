import { DotIcon } from '../reader/chrome/parts';
import { SPARK, SPARK_DIM } from './glyphs';
import type { AiProgress } from './progress';
import './ai.css';

/* Apart from AiStatus.tsx, so a card's spark loads without the rest of the AI's drawings. */

/** The spark: beating while it reads or waits, lit when done, faint while off. */
export function Spark({ p, className = '' }: { p: AiProgress; className?: string }) {
  return (
    <span className={`ai-spark is-${p.stage} ${className}`} aria-hidden="true">
      <span className="ai-spark-a"><DotIcon rows={SPARK} /></span>
      <span className="ai-spark-b"><DotIcon rows={SPARK_DIM} /></span>
    </span>
  );
}
