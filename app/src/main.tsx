import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./explore/explore.css";
import "./welcome/welcome.css";

// The address the visitor arrived with, read before the app writes the canonical scenario into
// the URL: it decides whether this is a first root visit (welcome) or a scenario link.
const entrySearch = window.location.search;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App entrySearch={entrySearch} />
  </StrictMode>,
);
