import '../App.css';
import '../styles/ui-unified-2026.css';
import '../styles/liquid-glass-26.css';
import '../styles/liquid-glass-system.css';
import '../styles/responsive-text-safety.css';
import { ManualPage } from '../pages/ManualPage';

/**
 * Browser-only typography regression surface. It renders the real manual page
 * without invoking Tauri commands so long CJK/Latin headings can be audited at
 * narrow viewports and high UI scale bands without touching the live app.
 */
export function ManualVisualReview() {
  return (
    <div className="app-container manual-visual-review-shell">
      <div className="main-wrapper">
        <ManualPage onNavigate={() => undefined} onOpenPlatformLayout={() => undefined} />
      </div>
    </div>
  );
}
