import { describe, expect, it } from "vitest";
import {
	collectComponents,
	componentReturnExpressions,
	resolveComponentRef,
} from "../../../analysis/tsx/componentGraph";
import { makeWorkspace, memoryPath } from "../helpers/inMemory";

function resolve(files: Record<string, string>, from: string, tag: string) {
	const ws = makeWorkspace(files);
	const sourceFile = ws.project.getSourceFileOrThrow(memoryPath(from));
	return {
		ws,
		resolution: resolveComponentRef(ws, ws.project, sourceFile, tag),
	};
}

describe("resolveComponentRef", () => {
	it("resolves a default export through a .tsx candidate", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import Card from "./Card";\nexport default function App() { return <Card />; }',
				"src/Card.tsx": "export default function Card() { return <div />; }",
			},
			"src/App.tsx",
			"Card",
		);
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.definition.id).toBe("src/Card.tsx#default");
			expect(resolution.definition.exportKind).toBe("default");
		}
	});

	it("keeps the declared name even when the import is aliased", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import CardAlias from "./Card";\nexport default function App() { return <CardAlias />; }',
				"src/Card.tsx": "export default function Card() { return <div />; }",
			},
			"src/App.tsx",
			"CardAlias",
		);
		if (resolution.kind !== "local") {
			throw new Error("expected a local component");
		}
		expect(resolution.definition.name).toBe("Card");
	});

	// A module that renames a local declaration on the way out —
	// `function Card() {}; export { Card as CheckoutCard }` — resolved to nothing,
	// because only an import binding named `Card` was looked for. The component
	// then became a tree boundary and everything it renders went unseen.
	it("resolves an aliased export of a locally declared component", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import { CheckoutCard } from "./Card";\nexport default function App() { return <CheckoutCard />; }',
				"src/Card.tsx":
					"function Card() { return <div data-testid='c' />; }\nexport { Card as CheckoutCard };",
			},
			"src/App.tsx",
			"CheckoutCard",
		);
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.definition.name).toBe("Card");
			expect(resolution.definition.file).toBe("src/Card.tsx");
		}
	});

	// The importer's local alias is not an identity. Deriving one from it gave the
	// same anonymous component a different id in every file that rendered it, so
	// cross-references pointed at definitions that did not exist.
	it("gives an anonymous default export one id, whatever the importer calls it", () => {
		const files = {
			"src/Card.tsx": "export default () => <div data-testid='c' />;",
			"src/A.tsx":
				'import Alpha from "./Card";\nexport function A() { return <Alpha />; }',
			"src/B.tsx":
				'import Beta from "./Card";\nexport function B() { return <Beta />; }',
		};
		const viaAlpha = resolve(files, "src/A.tsx", "Alpha").resolution;
		const viaBeta = resolve(files, "src/B.tsx", "Beta").resolution;
		if (viaAlpha.kind !== "local" || viaBeta.kind !== "local") {
			throw new Error("expected local components");
		}
		expect(viaAlpha.definition.id).toBe("src/Card.tsx#default");
		expect(viaBeta.definition.id).toBe(viaAlpha.definition.id);
		expect(viaAlpha.definition.exportKind).toBe("default");
		expect(viaAlpha.definition.name).toBe("Card");
	});

	it("names an anonymous default-exported function after its file too", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import Anything from "./Card";\nexport default function App() { return <Anything />; }',
				"src/Card.tsx": "export default function () { return <div />; }",
			},
			"src/App.tsx",
			"Anything",
		);
		if (resolution.kind !== "local") {
			throw new Error("expected a local component");
		}
		expect(resolution.definition.id).toBe("src/Card.tsx#default");
		expect(resolution.definition.name).toBe("Card");
	});

	it("resolves a named export declared as a const arrow", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import { Card } from "./Card";\nexport default function App() { return <Card />; }',
				"src/Card.tsx": "export const Card = () => <div />;",
			},
			"src/App.tsx",
			"Card",
		);
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.definition.exportKind).toBe("named");
			expect(resolution.definition.id).toBe("src/Card.tsx#Card");
		}
	});

	it("reports a component from another package as external", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import { Button } from "@acme/ui";\nexport default function App() { return <Button />; }',
			},
			"src/App.tsx",
			"Button",
		);
		expect(resolution).toEqual({ kind: "external", module: "@acme/ui" });
	});

	it("reports a dotted tag as unresolved", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import * as UI from "./ui";\nexport default function App() { return <UI.Card />; }',
				"src/ui.tsx": "export const Card = () => <div />;",
			},
			"src/App.tsx",
			"UI.Card",
		);
		expect(resolution.kind).toBe("unresolved");
	});

	it("reads destructured prop names and spread forwarding", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import Card from "./Card";\nexport default function App() { return <Card />; }',
				"src/Card.tsx":
					"export default function Card({ testId, ...rest }: { testId: string }) { return <div data-testid={testId} {...rest} />; }",
			},
			"src/App.tsx",
			"Card",
		);
		if (resolution.kind !== "local") {
			throw new Error("expected a local component");
		}
		expect(resolution.definition.propNames).toEqual(["testId"]);
		expect(resolution.definition.spreadSourceNames).toEqual(["rest"]);
		expect(resolution.definition.forwardsSpread).toBe(true);
	});

	it("reports the prop name, not the local alias, and records the hop", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import Card from "./Card";\nexport default function App() { return <Card />; }',
				"src/Card.tsx":
					"export default function Card({ testId: id }: { testId: string }) { return <div data-testid={id} />; }",
			},
			"src/App.tsx",
			"Card",
		);
		if (resolution.kind !== "local") {
			throw new Error("expected a local component");
		}
		expect(resolution.definition.propNames).toEqual(["testId"]);
		expect([...resolution.definition.propAliases]).toEqual([["id", "testId"]]);
	});
});

describe("componentReturnExpressions", () => {
	it("returns the concise body of an arrow component", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import { Card } from "./Card";\nexport default function App() { return <Card />; }',
				"src/Card.tsx": "export const Card = () => <div />;",
			},
			"src/App.tsx",
			"Card",
		);
		if (resolution.kind !== "local") {
			throw new Error("expected a local component");
		}
		expect(componentReturnExpressions(resolution.definition.fn)).toHaveLength(
			1,
		);
	});

	it("ignores returns that belong to inner callbacks", () => {
		const { resolution } = resolve(
			{
				"src/App.tsx":
					'import Card from "./Card";\nexport default function App() { return <Card />; }',
				"src/Card.tsx": [
					"export default function Card() {",
					"  const rows = [1].map((n) => { return n * 2; });",
					"  void rows;",
					"  return <div />;",
					"}",
				].join("\n"),
			},
			"src/App.tsx",
			"Card",
		);
		if (resolution.kind !== "local") {
			throw new Error("expected a local component");
		}
		expect(componentReturnExpressions(resolution.definition.fn)).toHaveLength(
			1,
		);
	});
});

describe("collectComponents", () => {
	it("indexes capitalised function and const components", () => {
		const ws = makeWorkspace({
			"src/Card.tsx": [
				"export default function Card() { return <div />; }",
				"export const Badge = () => <span />;",
				"function helper() { return 1; }",
				"void helper;",
			].join("\n"),
		});
		const components = collectComponents(ws, ws.jsxFiles());
		expect(Object.keys(components).sort()).toEqual([
			"src/Card.tsx#Badge",
			"src/Card.tsx#default",
		]);
	});

	// The tree resolves `<Card/>` straight to this declaration, so leaving it out
	// of the inventory left every `componentRef` pointing at nothing.
	it("indexes a directly default-exported arrow component", () => {
		const ws = makeWorkspace({
			"src/Card.tsx": "export default () => <div data-testid='c' />;",
		});
		const components = collectComponents(ws, ws.jsxFiles());
		expect(Object.keys(components)).toEqual(["src/Card.tsx#default"]);
		expect(components["src/Card.tsx#default"]).toMatchObject({
			name: "Card",
			exportKind: "default",
		});
	});

	it("reads a quoted destructured prop under its real name", () => {
		const ws = makeWorkspace({
			"src/Card.tsx": [
				'export function Card({ "data-testid": id }: { "data-testid"?: string }) {',
				"  return <div data-testid={id} />;",
				"}",
			].join("\n"),
		});
		const components = collectComponents(ws, ws.jsxFiles());
		expect(components["src/Card.tsx#Card"].propNames).toEqual(["data-testid"]);
	});

	it("leaves a computed destructured key out of the prop names", () => {
		const ws = makeWorkspace({
			"src/Card.tsx": [
				"const key = 'data-testid';",
				"export function Card({ [key]: id, title }: Record<string, string>) {",
				"  return <div data-testid={id}>{title}</div>;",
				"}",
			].join("\n"),
		});
		const components = collectComponents(ws, ws.jsxFiles());
		expect(components["src/Card.tsx#Card"].propNames).toEqual(["title"]);
	});
});
