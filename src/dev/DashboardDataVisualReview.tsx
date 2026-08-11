import '../App.css';
import '../styles/ui-unified-2026.css';
import '../styles/liquid-glass-26.css';
import '../styles/liquid-glass-system.css';
import '../styles/responsive-text-safety.css';
import { DashboardPage } from '../pages/DashboardPage';

/** Browser-only account-overview geometry review. Service calls fail closed
 * outside Tauri, so this can validate the real header and layout control
 * without touching the running desktop process. */
export function DashboardDataVisualReview() {
  return (
    <div className="app-container dashboard-data-visual-review-shell">
      <div className="main-wrapper">
        <DashboardPage
          onNavigate={() => undefined}
          onOpenPlatformLayout={() => undefined}
          onEasterEggTriggerClick={() => undefined}
        />
      </div>
    </div>
  );
}
