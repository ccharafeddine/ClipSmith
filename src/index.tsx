/* @refresh reload */
import { render } from "solid-js/web";
import "./tokens.css";
import "./fonts.css";
import "./smith/tokens.css";
import "./smith/components.css";
import App from "./App";

document.documentElement.dataset.app = "clipsmith";

render(() => <App />, document.getElementById("root") as HTMLElement);
