import '../App.css';
import '../styles/ui-unified-2026.css';
import '../styles/liquid-glass-26.css';
import '../styles/liquid-glass-system.css';
import '../styles/macos-native-liquid-glass.css';
import '../styles/responsive-text-safety.css';
import { MultiModelApiServicePage } from './MultiModelApiServicePage';

/** Dedicated host: it does not mount the account console or its refresh jobs. */
export function MultiModelApiServiceWindow() {
  return (
    <div className="mm-api-standalone-window">
      <MultiModelApiServicePage standalone />
    </div>
  );
}
