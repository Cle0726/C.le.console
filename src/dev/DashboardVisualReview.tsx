import "../App.css";
import "../styles/ui-unified-2026.css";
import "../styles/liquid-glass-26.css";
import "../styles/liquid-glass-system.css";
import "../styles/responsive-text-safety.css";
import "./DashboardVisualReview.css";
import { AmbientInteractionLayer } from "../components/AmbientInteractionLayer";
import { DashboardLaunchpad } from "../components/DashboardShowcase";
import { SignatureCursorLayer } from "../components/SignatureCursorLayer";

/**
 * Browser-only dashboard regression surface.
 *
 * It renders the real launchpad and WebGL core without invoking account or
 * sidecar commands, allowing blur/material regressions to be inspected while
 * the user's live API services remain untouched.
 */
export function DashboardVisualReview() {
  return (
    <div className="dashboard-visual-review-shell">
      <AmbientInteractionLayer />
      <SignatureCursorLayer />
      <div className="main-wrapper">
        <DashboardLaunchpad
          modelCount={6}
          quotaPercent={64}
          quotaModelLabel="Gemini"
          onOpenModels={() => undefined}
          onOpenData={() => undefined}
          onOpenEgress={() => undefined}
        />
      </div>
    </div>
  );
}
