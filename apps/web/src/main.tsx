import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { useApp } from "./lib/store";
import { TooltipProvider } from "./components/ui/tooltip";
import "./index.css";

useApp.getState().init();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <TooltipProvider delayDuration={300}>
        <App />
      </TooltipProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
