import '../App.css';
import '../styles/ui-unified-2026.css';
import '../styles/liquid-glass-26.css';
import '../styles/liquid-glass-system.css';
import '../styles/responsive-text-safety.css';
import { JimengApiServicePage } from './JimengApiServicePage';

/** Dedicated, full-size host for the unified multi-platform creator workbench. */
export function WebCreatorWorkspaceWindow() {
  return <JimengApiServicePage standaloneWebCreator />;
}
