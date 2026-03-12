import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { App } from "./App";
import { MapPage } from "./pages/MapPage";
import { LivePage } from "./pages/LivePage";
import { FeatureRequestPage } from "./pages/FeatureRequestPage";
import { HotRightNowPage } from "./pages/HotRightNowPage";
import { OldSplashPage } from "./pages/OldSplashPage";

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<App />} />
      <Route path="/map" element={<MapPage />} />
      <Route path="/live" element={<LivePage />} />
      <Route path="/feature-request" element={<FeatureRequestPage />} />
      <Route path="/hot-right-now" element={<HotRightNowPage />} />
      <Route path="/heatbrothers" element={<OldSplashPage />} />
    </Routes>
  </BrowserRouter>,
);
