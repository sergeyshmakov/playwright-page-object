import {
  PageObject,
  SelectorByRole,
} from "playwright-page-object";
import { ButtonControl } from "./controls/ButtonControl";

export class CartItemControl extends PageObject {
  @SelectorByRole("button", { name: "Remove" })
  accessor RemoveButton = new ButtonControl();

  async expectVisible() {
    await this.waitVisible();
  }
}
