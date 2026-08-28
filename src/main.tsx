import React, { useEffect, useState, type ComponentType, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles/startup-shell.css";
import { StartupGreeting } from "./components/StartupGreeting";
import { UpdateNotifier } from "./components/UpdateNotifier";
import { initI18n } from "./i18n";
import {
  captureError,
  initErrorReporter,
  markFrontendReady,
  recordFrontendStage,
} from "./utils/errorReporter";
import { initializeVisualTheme } from "./utils/visualTheme";
import { initializePerformanceMode } from "./utils/performanceMode";
import { initializeLiquidGlassInteractions } from "./utils/liquidGlassInteractions";
import { initializeFrameGovernor } from "./utils/frameGovernor";

function enableMacOSNativeLiquidGlassTheme() {
  const runtimePlatform = (navigator as Navigator & {
    userAgentData?: { platform?: string };
  }).userAgentData?.platform || navigator.platform || navigator.userAgent || "";

  if (/mac/i.test(runtimePlatform) && "__TAURI_INTERNALS__" in window) {
    document.documentElement.setAttribute("data-native-liquid-glass", "true");
  }
}

enableMacOSNativeLiquidGlassTheme();

const visualReviewParams = new URLSearchParams(window.location.search);
const visualReviewTarget = ["127.0.0.1", "localhost"].includes(window.location.hostname)
  ? visualReviewParams.get("visual-review")
  : null;

if (visualReviewTarget) {
  const visualReviewTheme =
    visualReviewParams.get("visual-theme") === "day" ? "day" : "night";
  document.documentElement.setAttribute("data-visual-theme", visualReviewTheme);
  document.documentElement.setAttribute(
    "data-theme",
    visualReviewTheme === "night" ? "dark" : "light",
  );
  document.documentElement.style.colorScheme =
    visualReviewTheme === "night" ? "dark" : "light";
  document.documentElement.setAttribute("data-performance-mode", "full");
} else {
  initializeVisualTheme();
  initializePerformanceMode();
  initializeFrameGovernor();
  initErrorReporter();
  recordFrontendStage("script_loaded");
  void initI18n();
}
initializeLiquidGlassInteractions();

const rootElement = document.getElementById("root");
if (!rootElement) {
  const error = new Error("Root element not found");
  captureError(error, { source: "frontend_boot", phase: "root_lookup" });
  throw error;
}

if (!visualReviewTarget) {
  recordFrontendStage("react_mount_start");
}
const root = ReactDOM.createRoot(rootElement);

type DeferredApp = ComponentType<{ startupReady?: boolean }>;
type DeferredGuard = ComponentType<{ children: ReactNode }>;

function MainWindowBootstrap() {
  const [loaded, setLoaded] = useState<{ App: DeferredApp; Guard: DeferredGuard } | null>(null);
  const [appPaintReady, setAppPaintReady] = useState(false);
  const [startupComplete, setStartupComplete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      import("./App"),
      import("./components/AppRuntimeGuard"),
    ]).then(([{ default: App }, { AppRuntimeGuard }]) => {
      if (!cancelled) setLoaded({ App, Guard: AppRuntimeGuard });
    }).catch((error) => {
      captureError(error, { source: "frontend_boot", phase: "app_dynamic_import" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setAppPaintReady(true));
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [loaded]);

  const LoadedApp = loaded?.App;
  const Guard = loaded?.Guard;

  return (
    <>
      {LoadedApp && Guard && (
        <Guard>
          <LoadedApp startupReady={startupComplete} />
        </Guard>
      )}
      {startupComplete && <UpdateNotifier />}
      {!startupComplete && (
        <StartupGreeting
          readyGate={appPaintReady}
          onComplete={() => setStartupComplete(true)}
        />
      )}
    </>
  );
}

if (visualReviewTarget === "jimeng") {
  void import("./dev/JimengVisualReview").then(({ JimengVisualReview }) => {
    root.render(
      <React.StrictMode>
        <JimengVisualReview />
      </React.StrictMode>,
    );
  });
} else if (visualReviewTarget === "jimeng-canvas") {
  void import("./dev/JimengCanvasVisualReview").then(({ JimengCanvasVisualReview }) => {
    root.render(
      <React.StrictMode>
        <JimengCanvasVisualReview />
      </React.StrictMode>,
    );
  });
} else if (visualReviewTarget === "dashboard") {
  void import("./dev/DashboardVisualReview").then(({ DashboardVisualReview }) => {
    root.render(
      <React.StrictMode>
        <DashboardVisualReview />
      </React.StrictMode>,
    );
  });
} else if (visualReviewTarget === "dashboard-data") {
  void import("./dev/DashboardDataVisualReview").then(({ DashboardDataVisualReview }) => {
    root.render(
      <React.StrictMode>
        <DashboardDataVisualReview />
      </React.StrictMode>,
    );
  });
} else if (visualReviewTarget === "manual") {
  void import("./dev/ManualVisualReview").then(({ ManualVisualReview }) => {
    root.render(
      <React.StrictMode>
        <ManualVisualReview />
      </React.StrictMode>,
    );
  });
} else if (
  "__TAURI_INTERNALS__" in window
  && getCurrentWindow().label === "web-creator-workspace"
) {
  void import("./pages/WebCreatorWorkspaceWindow").then(({ WebCreatorWorkspaceWindow }) => {
    root.render(
      <React.StrictMode>
        <WebCreatorWorkspaceWindow />
      </React.StrictMode>,
    );
  });
} else if (
  !("__TAURI_INTERNALS__" in window)
  || ![
    "floating-card",
    "status-window",
  ].some((label) => {
    const currentLabel = getCurrentWindow().label;
    return label === "floating-card"
      ? currentLabel === label || currentLabel.startsWith("instance-floating-card-")
      : currentLabel === label;
  })
) {
  root.render(
    <React.StrictMode>
      <MainWindowBootstrap />
    </React.StrictMode>,
  );
} else {
  void Promise.all([
    import("./App"),
    import("./components/AppRuntimeGuard"),
  ]).then(([{ default: App }, { AppRuntimeGuard }]) => {
    root.render(
      <React.StrictMode>
        <AppRuntimeGuard>
          <App />
        </AppRuntimeGuard>
      </React.StrictMode>,
    );
  });
}

if (!visualReviewTarget) {
  window.requestAnimationFrame(() => {
    markFrontendReady("react_mounted");
  });
}
