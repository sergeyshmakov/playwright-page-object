import type {
	MaybeStatic,
	MemberNode,
	MethodInfo,
	PageObjectNode,
	PageObjectTree,
	SelectorInfo,
} from "../analysis";
import { isDynamicMember } from "../analysis";

/**
 * The indented text a page-object tree renders as.
 *
 * Split from its test-id-tree sibling in `outline.ts`, which the two specs had
 * already been treating as separate subjects. Both are token-lean plain text
 * for reading rather than parsing, and both are what the tree tools return by
 * default (`schemas.ts`); `format: "json"` is the machine-parseable form.
 */

function formatValue(value: MaybeStatic | undefined): string {
	if (value === undefined) {
		return "";
	}
	if (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		(value as { kind?: unknown }).kind === "dynamic"
	) {
		return `dynamic(${(value as { source: string }).source})`;
	}
	return JSON.stringify(value);
}

function selectorLabel(selector: SelectorInfo | undefined | null): string {
	if (!selector) {
		return "";
	}
	switch (selector.kind) {
		case "self":
			return "@self";
		case "testId":
			return `@testId ${formatValue(selector.testId)}`;
		case "testIdPattern":
			return selector.pattern
				? `@testIdPattern /${selector.pattern.source}/${selector.pattern.flags}`
				: `@testIdPattern ${selector.raw}`;
		case "role": {
			const options = selector.options
				? ` ${formatValue(selector.options)}`
				: "";
			return `@role ${formatValue(selector.role)}${options}`;
		}
		case "custom":
			return `@custom ${selector.raw}`;
		default: {
			const options = selector.options
				? ` ${formatValue(selector.options)}`
				: "";
			return `@${selector.kind} ${formatValue(selector.text)}${options}`;
		}
	}
}

function resultLabel(member: MemberNode): string {
	const result = member.result;
	switch (result.kind) {
		case "locator":
			return "Locator";
		case "pageObject":
			return result.className;
		case "list":
			return `${result.listClassName}<${result.itemClassName ?? "PageObject"}>`;
		case "control":
			return result.className ?? "control(dynamic)";
		default:
			return "unknown";
	}
}

function memberRefs(member: MemberNode): string[] {
	const result = member.result;
	switch (result.kind) {
		case "pageObject":
			return result.ref ? [result.ref] : [];
		case "control":
			return result.ref ? [result.ref] : [];
		case "list":
			// A user-defined list subclass carries its own selectors and methods;
			// the library's own ListPageObject stub is noise on every list member.
			return [result.listRef, result.itemRef].filter(
				(ref): ref is string => ref !== null,
			);
		default:
			return [];
	}
}

/**
 * Why a `$ref` has no definition in the tree.
 *
 * `(unresolved)` used to cover all three cases, and it is the wrong answer for
 * two of them: the class resolves perfectly well, the walk just stopped before
 * reaching it. A reader told "unresolved" goes looking for a broken import; one
 * told "depth limit" re-calls with a bigger depth and gets the answer.
 */
function missingRefLabel(
	owner: PageObjectNode | undefined,
	tree: PageObjectTree,
): string {
	if (owner?.warnings?.some((one) => one.code === "depth-limit-reached")) {
		return "(not expanded: depth limit)";
	}
	if (tree.warnings.some((one) => one.code === "node-budget-reached")) {
		return "(not expanded: node budget)";
	}
	return "(unresolved)";
}

function methodMarks(method: MethodInfo): string {
	const marks: string[] = [];
	if (method.inherited) {
		marks.push(
			method.declaredIn ? `inherited: ${method.declaredIn}` : "inherited",
		);
	}
	if (method.visibility === "protected") {
		marks.push("protected");
	}
	if (method.isStatic) {
		marks.push("static");
	}
	return marks.length > 0 ? ` [${marks.join(", ")}]` : "";
}

export function renderPageObjectOutline(tree: PageObjectTree): string {
	const lines: string[] = [];
	const visited = new Set<string>();

	function renderDef(id: string, indent: string, owner?: PageObjectNode): void {
		const def: PageObjectNode | undefined = tree.defs[id];
		if (!def) {
			lines.push(`${indent}${id} ${missingRefLabel(owner, tree)}`);
			return;
		}
		if (visited.has(id)) {
			lines.push(`${indent}${def.className} (see above)`);
			return;
		}
		visited.add(id);

		const rootSelector = def.rootSelector
			? `  ${selectorLabel(def.rootSelector)}`
			: "";
		// The one fact that decides the first line of the test. Without it an
		// outline reader constructs `new CheckoutPage(page)` in a suite where the
		// binding already exists and every other spec takes it as an argument; the
		// JSON format has carried `fixtures` all along.
		const fixtures =
			def.fixtures && def.fixtures.length > 0
				? `  fixture: ${def.fixtures.map((fixture) => fixture.name).join(", ")}`
				: "";
		lines.push(
			`${indent}${def.className} (${def.hostKind})${rootSelector}  ${def.file}${fixtures}`,
		);

		for (const member of def.members) {
			const dynamicMark = isDynamicMember(member) ? " [dynamic]" : "";
			lines.push(
				`${indent}  ${member.name} -> ${resultLabel(member)}  ${selectorLabel(member.selector)}${dynamicMark}`,
			);
			for (const ref of memberRefs(member)) {
				if (tree.defs[ref]?.external) {
					continue;
				}
				renderDef(ref, `${indent}    `, def);
			}
		}

		// Split, because the two are called differently: `await p.apply()` against
		// `p.total`. One `methods:` line made a getter look like a method, which is
		// a `TypeError` an agent only finds at run time.
		const methods = def.methods.filter((method) => method.kind === "method");
		const accessors = def.methods.filter((method) => method.kind !== "method");
		if (methods.length > 0) {
			lines.push(
				`${indent}  methods: ${methods
					.map((method) => `${method.signature}${methodMarks(method)}`)
					.join(", ")}`,
			);
		}
		if (accessors.length > 0) {
			lines.push(
				`${indent}  accessors: ${accessors
					.map((method) => `${method.signature}${methodMarks(method)}`)
					.join(", ")}`,
			);
		}
	}

	renderDef(tree.root, "");
	return lines.join("\n");
}
