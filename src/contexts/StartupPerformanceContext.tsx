import { createContext, useContext, type ReactNode } from 'react';

const StartupPerformanceContext = createContext(true);

export function StartupPerformanceProvider({
  ready,
  children,
}: {
  ready: boolean;
  children: ReactNode;
}) {
  return (
    <StartupPerformanceContext.Provider value={ready}>
      {children}
    </StartupPerformanceContext.Provider>
  );
}

export function useStartupPerformanceReady(): boolean {
  return useContext(StartupPerformanceContext);
}
