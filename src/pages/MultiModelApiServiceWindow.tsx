import '../App.css';
import '../styles/ui-unified-2026.css';
import '../styles/liquid-glass-26.css';
import '../styles/liquid-glass-system.css';
import '../styles/macos-native-liquid-glass.css';
import '../styles/responsive-text-safety.css';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { MultiModelApiServicePage } from './MultiModelApiServicePage';

/** Dedicated host: it does not mount the account console or its refresh jobs. */
export function MultiModelApiServiceWindow() {
  const handleWindowDrag = () => {
    void getCurrentWindow().startDragging().catch(() => {
      // The page can also be opened in a browser during development.
    });
  };

  return (
    <div className="mm-api-standalone-window">
      <div
        className="mm-api-window-drag-region"
        data-tauri-drag-region
        onMouseDown={handleWindowDrag}
        aria-hidden="true"
      />
      <MultiModelApiServicePage standalone />
    </div>
  );
}
