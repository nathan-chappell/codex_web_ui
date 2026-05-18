import React from "react";
import { ClerkProvider } from "@clerk/react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { CLERK_PUBLISHABLE_KEY } from "./authConfig";
import "./styles.css";

const app = CLERK_PUBLISHABLE_KEY ? (
  <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} afterSignOutUrl="/">
    <App />
  </ClerkProvider>
) : (
  <App />
);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {app}
  </React.StrictMode>
);
