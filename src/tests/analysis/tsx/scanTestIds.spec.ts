import { describe, expect, it } from "vitest";
import { isCatchAllPattern } from "../../../analysis/coverage/match";
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

	// The field shape: a ternary interpolated at the head of a template. Read as
	// one opaque hole it compiles to `^.+BedListItem_.+$`, which no probe can
	// reconcile with a selector for `MainBedListItem` — so both @ListSelectors
	// the line serves were reported dead.
	it("expands a ternary hole into one pattern per branch", () => {
		const { occurrences } = scan(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source for the parser, not an interpolation
			'    <div data-testid={`${cond ? "Additional" : "Main"}BedListItem_${id}`} />',
		);

		expect(occurrences).toHaveLength(2);
		expect(occurrences.map((entry) => entry.value.regex?.source)).toEqual([
			"^AdditionalBedListItem_.+$",
			"^MainBedListItem_.+$",
		]);
		// The branch literal and the literal that follows it are one anchor, and
		// `prefix` is only ever the first part — unmerged it would read "Main".
		expect(occurrences.map((entry) => entry.value.prefix)).toEqual([
			"AdditionalBedListItem_",
			"MainBedListItem_",
		]);
		expect(occurrences.every((entry) => entry.conditional)).toBe(true);
		expect(occurrences[1].value.parts).toEqual([
			{ kind: "literal", text: "MainBedListItem_" },
			{ kind: "expr", text: "id" },
		]);
	});

	it("expands a ternary that is the whole template into two static ids", () => {
		const { occurrences } = scan(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source for the parser, not an interpolation
			'    <div data-testid={`${cond ? "A" : "B"}`} />',
		);

		// Not `^.+$`, which is a catch-all and gets quarantined: both ids are
		// written right there in the source.
		expect(occurrences.map((entry) => entry.value)).toMatchObject([
			{ kind: "static", value: "A" },
			{ kind: "static", value: "B" },
		]);
		expect(occurrences.every((entry) => entry.conditional)).toBe(true);
	});

	it("keeps a hole whose branches are not both static a generic hole", () => {
		const { occurrences } = scan(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source for the parser, not an interpolation
			'    <div data-testid={`${cond ? id : "Main"}BedListItem_${id}`} />',
		);

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].value).toMatchObject({
			kind: "pattern",
			regex: { source: "^.+BedListItem_.+$" },
		});
		// Anchored on a real literal, so it is not quarantined: a selector for
		// `BedListItem_` still matches it by probe.
		expect(isCatchAllPattern("^.+BedListItem_.+$")).toBe(false);
		expect(occurrences[0].conditional).toBeUndefined();
	});

	it("stops expanding past the variant cap", () => {
		const { occurrences } = scan(
			[
				"    <div data-testid={",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source for the parser, not an interpolation
				'      `${cond ? "A" : "B"}_${cond ? "C" : "D"}_${cond ? "E" : "F"}`',
				"    } />",
			].join("\n"),
		);

		// Eight ids from one element says less than the anchored pattern does.
		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].value).toMatchObject({
			kind: "pattern",
			regex: { source: "^.+_.+_.+$" },
		});
	});

	it("expands a ternary operand of a concatenation too", () => {
		const { occurrences } = scan(
			'    <div data-testid={(cond ? "Main" : "Extra") + "Row_" + id} />',
		);

		expect(occurrences.map((entry) => entry.value.regex?.source)).toEqual([
			"^MainRow_.+$",
			"^ExtraRow_.+$",
		]);
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

	// JSX resolves any dotted tag as a member expression: `<icons.Button/>` reads
	// `icons.Button` out of scope, whatever the namespace segment's case. Judging
	// the tag by that segment made it a host element, so the id written on it was
	// inventoried as a rendered DOM attribute instead of an unproven prop.
	it("treats a dotted tag as a component whatever the namespace's case", () => {
		const { elements, occurrences } = scan(
			'    <icons.Button data-testid="Save" />',
		);
		expect(elements[0].nodeType).toBe("component");
		expect(occurrences[0]).toMatchObject({
			tag: "icons.Button",
			reach: "component-prop",
		});
	});

	it("keeps a bare lowercase tag a host element", () => {
		const { elements, occurrences } = scan('    <div data-testid="Panel" />');
		expect(elements[0].nodeType).toBe("element");
		// Required, not absent: "nobody set the flag" and "the id reaches the DOM"
		// are different claims, and the scan has to make the second one out loud.
		expect(occurrences[0].reach).toBe("element");
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
