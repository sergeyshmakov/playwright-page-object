import type { Decorator, Node } from "ts-morph";
import type {
	Diagnostic,
	MaybeStatic,
	PatternInfo,
	SelectorInfo,
	SelectorKind,
} from "../types";
import {
	evaluateStatic,
	isDynamicValue,
	isRegexValue,
	literalPrefixOf,
	rawText,
	toMaybeStatic,
} from "../util/literal";
import { type SplitArgs, splitFactoryArg } from "./decoratorArgs";
import type { AnalysisContext, LibraryImports } from "./libraryImports";

export interface SelectorRead {
	selector: SelectorInfo;
	split: SplitArgs;
	warnings: Diagnostic[];
}

/** Canonical decorator name to the selector kind it produces. */
const KIND_BY_DECORATOR: Record<string, SelectorKind> = {
	Selector: "testId",
	RootSelector: "testId",
	ListSelector: "testIdPattern",
	ListRootSelector: "testIdPattern",
	SelectorByRole: "role",
	RootSelectorByRole: "role",
	SelectorByText: "text",
	RootSelectorByText: "text",
	SelectorByLabel: "label",
	RootSelectorByLabel: "label",
	SelectorByPlaceholder: "placeholder",
	RootSelectorByPlaceholder: "placeholder",
	SelectorByAltText: "altText",
	RootSelectorByAltText: "altText",
	SelectorByTitle: "title",
	RootSelectorByTitle: "title",
	SelectorBy: "custom",
};

/**
 * Builds the JSON form of a test-id pattern.
 *
 * A string mask goes through `new RegExp(mask)` at runtime (`selectors.ts:84-85`,
 * `rootSelectors.ts:99`), so it is an **unanchored** regex, not a prefix.
 */
export function readPattern(node: Node): PatternInfo | null {
	const evaluated = evaluateStatic(node);
	if (!evaluated.ok) {
		return null;
	}
	const value = evaluated.value;
	if (typeof value === "string") {
		return {
			source: value,
			flags: "",
			origin: "string",
			matchMode: "regexUnanchored",
			literalPrefix: literalPrefixOf(value),
		};
	}
	if (isRegexValue(value)) {
		return {
			source: value.source,
			flags: value.flags,
			origin: "regex",
			matchMode: "regex",
			literalPrefix: literalPrefixOf(value.source),
		};
	}
	return null;
}

function anyDynamic(values: Array<MaybeStatic | undefined>): boolean {
	return values.some((value) => value !== undefined && isDynamicValue(value));
}

/**
 * Reads one selector decorator into its wire form.
 *
 * The canonical name comes from the file's alias map, so
 * `import { Selector as S }` and `@S("x")` land here as `"Selector"`.
 */
export function readSelector(
	decorator: Decorator,
	canonicalName: string,
	imports: LibraryImports,
	ctx: AnalysisContext,
): SelectorRead {
	const sourceFile = decorator.getSourceFile();
	const args = decorator.getArguments();
	const split = splitFactoryArg(canonicalName, args, sourceFile, imports, ctx);
	const warnings = [...split.warnings];

	const raw = rawText(decorator);
	const baseKind = KIND_BY_DECORATOR[canonicalName] ?? "custom";
	const values = split.valueArgs;

	const selector: SelectorInfo = {
		kind: baseKind,
		decorator: canonicalName,
		raw,
		dynamic: false,
	};

	if (split.hasSpread) {
		selector.dynamic = true;
		selector.notes = [
			...(split.notes ?? []),
			"Spread argument: selector arguments are not statically known.",
		];
		return { selector, split, warnings };
	}

	switch (baseKind) {
		case "custom": {
			selector.dynamic = true;
			break;
		}
		case "testId": {
			if (values.length === 0) {
				selector.kind = "self";
				break;
			}
			const testId = toMaybeStatic(evaluateStatic(values[0]));
			selector.testId = testId;
			selector.dynamic = anyDynamic([testId]);
			break;
		}
		case "testIdPattern": {
			const pattern = values[0] ? readPattern(values[0]) : null;
			if (pattern) {
				selector.pattern = pattern;
			} else {
				selector.dynamic = true;
				if (values[0]) {
					selector.args = [toMaybeStatic(evaluateStatic(values[0]))];
				}
			}
			break;
		}
		case "role": {
			const role = values[0]
				? toMaybeStatic(evaluateStatic(values[0]))
				: undefined;
			const options = values[1]
				? toMaybeStatic(evaluateStatic(values[1]))
				: undefined;
			if (role !== undefined) {
				selector.role = role;
			}
			if (options !== undefined) {
				selector.options = options;
			}
			selector.dynamic = anyDynamic([role, options]);
			break;
		}
		default: {
			const text = values[0]
				? toMaybeStatic(evaluateStatic(values[0]))
				: undefined;
			const options = values[1]
				? toMaybeStatic(evaluateStatic(values[1]))
				: undefined;
			if (text !== undefined) {
				selector.text = text;
			}
			if (options !== undefined) {
				selector.options = options;
			}
			selector.dynamic = anyDynamic([text, options]);
			break;
		}
	}

	// Positional fallback: only when the mapped fields do not tell the whole
	// story, so the common case stays terse.
	if (
		values.length > 2 ||
		(selector.dynamic && selector.args === undefined && values.length > 0)
	) {
		selector.args = values.map((value) => toMaybeStatic(evaluateStatic(value)));
	}

	if (split.notes.length > 0) {
		selector.notes = [...(selector.notes ?? []), ...split.notes];
	}

	return { selector, split, warnings };
}

/** Root class decorators share the reader; they simply never carry a factory. */
export const readRootSelector = readSelector;
