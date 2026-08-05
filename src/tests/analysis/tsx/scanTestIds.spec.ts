import { describe, expect, it } from "vitest";
import {
	scanFileElements,
	scanFileTestIds,
} from "../../../analysis/tsx/scanTestIds";
import { makeWorkspace, memoryPath } from "../helpers/inMemory";

function scan(body: string, attribute = "data-testid") {
	const code = [
		"export default function Widget(props: { id: string; cond: boolean }) {",
		"  const { id, cond } = props;",
		"  void id; void cond;",
		"  return (",
		body,
		"  );",
		"}",
	].join("\n");
	const ws = makeWorkspace({ "src/Widget.tsx": code });
	const sourceFile = ws.project.getSourceFileOrThrow(
		memoryPath("src/Widget.tsx"),
	);
	return {
		elements: scanFileElements(sourceFile, attribute, "src/Widget.tsx"),
		occurrences: scanFileTestIds(sourceFile, attribute, "src/Widget.tsx"),
	};
}

describe("scanFileTestIds — value forms", () => {
	it("reads a plain string attribute", () => {
		const { occurrences } = scan('    <div data-testid="Panel" />');
		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].value).toMatchObject({
			kind: "static",
			value: "Panel",
		});
		expect(occurrences[0].tag).toBe("div");
		expect(occurrences[0].component).toBe("Widget");
	});

	it("reads a braced string and a plain template as static", () => {
		expect(
			scan('    <div data-testid={"Panel"} />').occurrences[0].value,
		).toMatchObject({ kind: "static", value: "Panel" });
		expect(
			scan("    <div data-testid={`Panel`} />").occurrences[0].value,
		).toMatchObject({ kind: "static", value: "Panel" });
	});

	it("turns a template literal with a hole into an anchored pattern", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source for the parser, not an interpolation
		const { occurrences } = scan("    <div data-testid={`CartItem_${id}`} />");
		expect(occurrences[0].value).toMatchObject({
			kind: "pattern",
			prefix: "CartItem_",
			regex: { source: "^CartItem_.+$", flags: "" },
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the scanner echoes the fixture text verbatim
			raw: "`CartItem_${id}`",
		});
		expect(occurrences[0].value.parts).toEqual([
			{ kind: "literal", text: "CartItem_" },
			{ kind: "expr", text: "id" },
		]);
	});

	it("treats string concatenation the same as a template", () => {
		const { occurrences } = scan('    <div data-testid={"Row_" + id} />');
		expect(occurrences[0].value).toMatchObject({
			kind: "pattern",
			prefix: "Row_",
			regex: { source: "^Row_.+$" },
		});
	});

	it("escapes regex metacharacters in the literal parts", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source for the parser, not an interpolation
		const { occurrences } = scan("    <div data-testid={`item.${id}`} />");
		expect(occurrences[0].value.regex?.source).toBe("^item\\..+$");
	});

	it("splits a two-branch static ternary into two conditional occurrences", () => {
		const { occurrences } = scan('    <div data-testid={cond ? "A" : "B"} />');
		expect(occurrences).toHaveLength(2);
		expect(occurrences.map((entry) => entry.value.value)).toEqual(["A", "B"]);
		expect(occurrences.every((entry) => entry.conditional)).toBe(true);
	});

	it("reports a bare identifier as dynamic", () => {
		const { occurrences } = scan("    <div data-testid={id} />");
		expect(occurrences[0].value).toMatchObject({
			kind: "dynamic",
			raw: "id",
			reason: "computed-expression",
		});
	});

	it("honours a custom attribute name", () => {
		const { occurrences } = scan('    <div data-qa="Panel" />', "data-qa");
		expect(occurrences[0].value).toMatchObject({ value: "Panel" });
		expect(scan('    <div data-qa="Panel" />').occurrences).toHaveLength(0);
	});
});

describe("scanFileElements — element metadata", () => {
	it("distinguishes host elements from components", () => {
		const { elements } = scan("    <div><Card /></div>");
		expect(elements.map((element) => [element.tag, element.nodeType])).toEqual([
			["div", "element"],
			["Card", "component"],
		]);
	});

	it("flags elements rendered behind `&&`", () => {
		const { occurrences } = scan(
			'    <div>{cond && <span data-testid="Late" />}</div>',
		);
		expect(occurrences[0]).toMatchObject({ conditional: true });
	});

	it("flags elements rendered inside `.map()`", () => {
		const { occurrences } = scan(
			'    <div>{[1, 2].map((n) => (<span key={n} data-testid="Row" />))}</div>',
		);
		expect(occurrences[0]).toMatchObject({ repeated: true });
	});

	it("records spread attributes", () => {
		const { elements } = scan("    <div {...props} />");
		expect(elements[0].hasSpread).toBe(true);
		expect(elements[0].spreadNames).toEqual(["props"]);
	});

	it("keeps the enclosing component name across a map callback", () => {
		const { occurrences } = scan(
			'    <div>{[1].map((n) => (<span key={n} data-testid="Row" />))}</div>',
		);
		expect(occurrences[0].component).toBe("Widget");
	});

	it("records every attribute, not just the test id one", () => {
		const { elements } = scan('    <Card testId="Foo" title="Bar" />');
		expect([...elements[0].attributes.keys()].sort()).toEqual([
			"testId",
			"title",
		]);
	});
});
