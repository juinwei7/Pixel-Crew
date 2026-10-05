import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import { installInteractionFx } from "./interactionFx";

// 全站互動手感：按鈕長出彈窗、主要按鈕火花、延遲提示框、彩蛋（純視覺）。
installInteractionFx();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
