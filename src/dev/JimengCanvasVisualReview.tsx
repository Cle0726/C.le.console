import '../App.css';
import '../styles/ui-unified-2026.css';
import '../styles/liquid-glass-26.css';
import '../styles/liquid-glass-system.css';
import '../styles/responsive-text-safety.css';
import { JimengInfiniteCanvasPage } from '../pages/JimengInfiniteCanvasPage';

/**
 * Browser-only review surface for the standalone workspace integration.
 * It embeds the already-running Infinite Canvas service on port 3000 and
 * never starts, stops or mutates the user's 1466/15100 API processes.
 */
export function JimengCanvasVisualReview() {
  return (
    <div className="jimeng-canvas-visual-review-shell">
      <main className="jimeng-canvas-visual-review-content">
        <JimengInfiniteCanvasPage onNavigate={() => undefined} />
      </main>
    </div>
  );
}
