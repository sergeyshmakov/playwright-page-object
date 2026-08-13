import { Node, Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";
import {
	evaluateStatic,
	isDynamicValue,
	literalPrefixOf,
	parseRegexLiteral,
	rawText,
	toMaybeStatic,
} from "../../../analysis/util/literal";

function expr(code: string): Node {
	const project = new Project({ useInMemoryFileSystem: true });
	const file = project.createSourceFile("/x.ts", `const value = ${code};`);
	const declaration = file.getVariableDeclarationOrThrow("value");
	const initializer = declaration.getInitializer();
	if (!initializer) {
		throw new Error("fixture has no initializer");
	}
	return initializer;
}

function evaluate(code: string) {
	return evaluateStatic(expr(code));
}

describe("evaluateStatic", () => {
	it("reads string literals in both quote styles and template form", () => {
		expect(evaluate('"CheckoutPage"')).toEqual({
			ok: true,
			value: "CheckoutPage",
		});
		expect(evaluate("'x'")).toEqual({ ok: true, value: "x" });
		expect(evaluate("`plain`")).toEqual({ ok: true, value: "plain" });
	});

	it("sees through every transparent wrapper, including `<T>x`", () => {
		// The narrowing this closes. `evaluateStatic` is the one reader that runs
		// over `.ts` page objects, where the angle-bracket assertion is legal - it
		// is unparseable in the `.tsx` the other peels read - so it was the single
		// caller that could meet the form, and the single one that stopped at it.
		// `@Selector(<string>"Hello")` reported a plainly static id as dynamic.
		for (const code of [
			'<string>"Hello"',
			'"Hello" as string',
			'("Hello")',
			'"Hello" satisfies string',
			'("Hello" as string)!',
		]) {
			expect(evaluate(code), code).toEqual({ ok: true, value: "Hello" });
		}
	});

	it("reads numerics including a leading sign", () => {
		expect(evaluate("42")).toEqual({ ok: true, value: 42 });
		expect(evaluate("-1")).toEqual({ ok: true, value: -1 });
		expect(evaluate("+7")).toEqual({ ok: true, value: 7 });
	});

	it("reads booleans, null and undefined", () => {
		expect(evaluate("true")).toEqual({ ok: true, value: true });
		expect(evaluate("false")).toEqual({ ok: true, value: false });
		expect(evaluate("null")).toEqual({ ok: true, value: null });
		expect(evaluate("undefined")).toEqual({ ok: true, value: null });
	});

	it("encodes regex literals as JSON, preserving flags", () => {
		expect(evaluate("/^Item_\\d+$/i")).toEqual({
			ok: true,
			value: { kind: "regex", source: "^Item_\\d+$", flags: "i" },
		});
	});

	it("recurses through arrays and objects", () => {
		expect(evaluate('{ name: "Apply", exact: true, tags: [1, "a"] }')).toEqual({
			ok: true,
			value: { name: "Apply", exact: true, tags: [1, "a"] },
		});
	});

	it("accepts string keys and rejects computed keys", () => {
		expect(evaluate('{ "data-x": 1 }')).toEqual({
			ok: true,
			value: { "data-x": 1 },
		});
		const computed = evaluate("{ [key]: 1 }");
		expect(computed.ok).toBe(false);
		if (!computed.ok) {
			expect(computed.reason).toBe("computed-expression");
		}
	});

	it("unwraps `as const` and `satisfies`", () => {
		expect(evaluate('"Apply" as const')).toEqual({ ok: true, value: "Apply" });
		expect(evaluate('({ name: "Apply" }) satisfies object')).toEqual({
			ok: true,
			value: { name: "Apply" },
		});
	});

	it("fails on a spread, at any depth", () => {
		const inArray = evaluate("[...items]");
		expect(inArray.ok).toBe(false);
		if (!inArray.ok) {
			expect(inArray.reason).toBe("spread");
		}
		const inObject = evaluate("{ ...base, name: 'a' }");
		expect(inObject.ok).toBe(false);
		if (!inObject.ok) {
			expect(inObject.reason).toBe("spread");
		}
	});

	it("fails on a template literal with substitutions", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source for the parser, not an interpolation
		const result = evaluate("`CartItem_${id}`");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("template-literal");
		}
	});

	it("fails the whole expression when one nested value is dynamic", () => {
		const result = evaluate("{ name: label }");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("identifier-unresolved");
		}
	});

	it("reports bare identifiers and calls with distinct reasons", () => {
		const identifier = evaluate("label");
		const call = evaluate("makeName()");
		expect(identifier.ok).toBe(false);
		expect(call.ok).toBe(false);
		if (!identifier.ok) {
			expect(identifier.reason).toBe("identifier-unresolved");
		}
		if (!call.ok) {
			expect(call.reason).toBe("computed-expression");
		}
	});
});

describe("toMaybeStatic", () => {
	it("turns a failure into a dynamic marker carrying the source text", () => {
		const value = toMaybeStatic(evaluate("someHelper(1)"));
		expect(isDynamicValue(value)).toBe(true);
		if (isDynamicValue(value)) {
			expect(value.source).toBe("someHelper(1)");
			expect(value.reason).toBe("computed-expression");
		}
	});
});

describe("rawText", () => {
	it("collapses whitespace and truncates", () => {
		const node = expr("{\n  name:   'Apply'\n}");
		expect(rawText(node)).toBe("{ name: 'Apply' }");
		expect(rawText(node, 8)).toBe("{ name:…");
	});
});

describe("parseRegexLiteral", () => {
	it("splits source from flags", () => {
		expect(parseRegexLiteral("/a\\/b/gi")).toEqual({
			kind: "regex",
			source: "a\\/b",
			flags: "gi",
		});
	});
});

describe("literalPrefixOf", () => {
	it("returns the leading literal run", () => {
		expect(literalPrefixOf("CartItem_")).toBe("CartItem_");
		expect(literalPrefixOf("^Item_\\d+$")).toBe("Item_");
		expect(literalPrefixOf("^(a|b)")).toBeNull();
	});

	it("stops before a quantifier so the quantified char is excluded", () => {
		expect(literalPrefixOf("abc*d")).toBe("ab");
	});
});

describe("node kinds", () => {
	it("recognises the exact syntax kinds the evaluator branches on", () => {
		expect(expr("/x/").getKind()).toBe(SyntaxKind.RegularExpressionLiteral);
		expect(Node.isObjectLiteralExpression(expr("{}"))).toBe(true);
	});
});
