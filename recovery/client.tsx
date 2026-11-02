import { createRoot } from "react-dom/client";
import ControlPanel from "../components/control-panel";
createRoot(document.getElementById("root")!).render(
  <ControlPanel recoveryOnly />,
);
