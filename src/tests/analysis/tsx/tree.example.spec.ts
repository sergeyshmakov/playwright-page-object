import { describe, expect, it } from "vitest";
import { buildTestIdTree } from "../../../analysis/tsx/tree";
import type { UiNode } from "../../../analysis/types";
import { exampleWorkspace } from "../helpers/example";

function flatten(nodes: UiNode[]): UiNode[] {
	return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function byTestId(nodes: UiNode[], id: string): UiNode | undefined {
	return nodes.find((node) => node.testId?.value === id);
}

describe("example/src — full fidelity from the auto-detected entry", () => {
	const tree = buildTestIdTree(exampleWorkspace());
	const nodes = flatten(tree.roots);

	it("follows main.tsx to App and renders both top-level components", () => {
		expect(tree.fidelity).toBe("full");
		expect(tree.fidelityReason).toBeUndefined();
		expect(tree.attribute).toBe("data-testid");
		expect(tree.attributeSource).toBe("default");
		expect(tree.roots.map((node) => node.tag)).toEqual([
			"Header",
			"CheckoutPage",
		]);
		expect(tree.roots.map((node) => node.componentRef)).toEqual([
			"src/components/Header.tsx#default",
			"src/components/CheckoutPage.tsx#default",
		]);
	});

	it("places every static id under the component that declares it", () => {
		expect(byTestId(nodes, "SignIn")?.component).toBe("Header");
		expect(byTestId(nodes, "CheckoutPage")?.component).toBe("CheckoutPage");
		expect(byTestId(nodes, "PromoCodeInput")?.tag).toBe("input");
		expect(byTestId(nodes, "CartItemName")?.file).toBe(
			"src/components/CartItem.tsx",
		);
	});

	it("marks conditionally rendered ids", () => {
		expect(byTestId(nodes, "PromoApplied")?.conditional).toBe(true);
		expect(byTestId(nodes, "EmptyCart")?.conditional).toBe(true);
		expect(byTestId(nodes, "CartItemsList")?.conditional).toBe(true);
		expect(byTestId(nodes, "PromoSection")?.conditional).toBeUndefined();
	});

	it("expands the mapped CartItem component and models its template id", () => {
		const item = nodes.find((node) => node.tag === "CartItemComponent");
		expect(item).toMatchObject({
			nodeType: "component",
			repeated: true,
			componentRef: "src/components/CartItem.tsx#default",
		});
		const row = item?.children[0];
		expect(row?.testId).toMatchObject({
			kind: "pattern",
			prefix: "CartItem_",
			regex: { source: "^CartItem_.+$", flags: "" },
			// biome-ignore lint/suspicious/noTemplateCurlyInString: verbatim source text from example/src/components/CartItem.tsx
			raw: "`CartItem_${item.id}`",
		});
		expect(row?.repeated).toBe(true);
		// Elements are attributed to the component that declares them, not to
		// the local alias used at the call site.
		expect(row?.component).toBe("CartItem");
	});

	it("marks everything inside the repeated row as repeated too", () => {
		const names = ["CartItemName", "CartItemPrice", "Remove"];
		for (const name of names) {
			expect(byTestId(nodes, name)?.repeated).toBe(true);
		}
	});

	it("builds a complete inventory with no dynamic ids", () => {
		const ids = tree.inventory
			.map((entry) => entry.value.value ?? entry.value.prefix)
			.sort();
		expect(ids).toEqual([
			"ApplyPromoButton",
			"CartItemName",
			"CartItemPrice",
			"CartItem_",
			"CartItemsList",
			"CartSection",
			"CheckoutPage",
			"EmptyCart",
			"PromoApplied",
			"PromoCodeInput",
			"PromoSection",
			"Remove",
			"SignIn",
		]);
		expect(tree.stats.dynamic).toBe(0);
		expect(tree.truncated).toBeUndefined();
	});

	it("indexes the declared components", () => {
		expect(Object.keys(tree.components).sort()).toEqual([
			"src/App.tsx#default",
			"src/components/CartItem.tsx#default",
			"src/components/CheckoutPage.tsx#default",
			"src/components/Header.tsx#default",
		]);
	});
});

describe("example/src — flat mode", () => {
	it("keeps the same inventory when the entry is restricted away", () => {
		const full = buildTestIdTree(exampleWorkspace());
		const flat = buildTestIdTree(exampleWorkspace(), {
			include: ["src/components/**"],
		});
		expect(flat.fidelity).toBe("flat");
		expect(flat.roots).toEqual([]);
		expect(flat.fidelityReason).toBeTruthy();
		// Header lives outside the include glob, so its id is the only difference.
		const flatIds = new Set(flat.inventory.map((entry) => entry.value.raw));
		for (const entry of full.inventory) {
			if (entry.component === "Header") {
				continue;
			}
			expect(flatIds.has(entry.value.raw)).toBe(true);
		}
	});
});
