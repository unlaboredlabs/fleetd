import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createDataLayer } from "./data/queries";
import { DataProvider } from "./data/react";
import "./styles.css";

document.documentElement.dataset["platform"] = window.fleetd.platform;

const data = createDataLayer(window.fleetd.hub);

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <DataProvider layer={data}>
      <App />
    </DataProvider>
  </StrictMode>,
);
