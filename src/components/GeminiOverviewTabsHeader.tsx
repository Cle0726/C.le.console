import { PlatformOverviewTabsHeader, PlatformOverviewTab } from './platform/PlatformOverviewTabsHeader';

export type GeminiTab = PlatformOverviewTab;

interface GeminiOverviewTabsHeaderProps {
  active: GeminiTab;
  onTabChange?: (tab: GeminiTab) => void;
}

export function GeminiOverviewTabsHeader({
  active,
  onTabChange,
}: GeminiOverviewTabsHeaderProps) {
  return (
    <PlatformOverviewTabsHeader platform="gemini" active={active} onTabChange={onTabChange} />
  );
}
