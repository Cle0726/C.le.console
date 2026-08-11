import "../App.css";
import "../styles/ui-unified-2026.css";
import "../styles/liquid-glass-26.css";
import { AmbientInteractionLayer } from "../components/AmbientInteractionLayer";
import { SignatureCursorLayer } from "../components/SignatureCursorLayer";
import { StartupGreeting } from "../components/StartupGreeting";
import { JimengApiServicePage } from "../pages/JimengApiServicePage";

/**
 * Browser-only visual regression surface.
 *
 * It renders the real Jimeng page with the real global stylesheet and a
 * deterministic service state. It never starts or stops a local sidecar, so UI
 * screenshots can be taken while the user's live API processes keep running.
 */
export function JimengVisualReview() {
  return (
    <div className="jimeng-visual-review-shell">
      <AmbientInteractionLayer />
      <SignatureCursorLayer />
      <StartupGreeting />
      <main className="jimeng-visual-review-content">
        <JimengApiServicePage onOpenCanvas={() => undefined} />
      </main>
    </div>
  );
}
