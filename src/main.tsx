import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import { App } from "./App.tsx";
import { CloudGate } from "./Login.tsx";
import { CLOUD } from "./mode.ts";

createRoot(document.getElementById("root")!).render(
  CLOUD ? (
    <CloudGate>
      <App />
    </CloudGate>
  ) : (
    <App />
  ),
);
