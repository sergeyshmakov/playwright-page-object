import type {
	MaybeStatic,
	MemberNode,
	MethodInfo,
	PageObjectNode,
	PageObjectTree,
	SelectorInfo,
	TestIdTree,
	UiNode,
	UiUnresolvedReason,
} from "../analysis";

/**
 * Token-lean plain-text renderers for the two tree shapes. Outline output is
 * for reading, not parsing — the JSON format stays the default.
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

/** Mirrors the engine's `isDynamicMember`: a resolved-looking label can still be a guess. */
function isDynamic(member: MemberNode): boolean {
	return (
		member.selector.dynamic ||
		member.result.kind === "unknown" ||
		(member.result.kind === "control" && member.result.dynamic === true)
	);
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
			const dynamicMark = isDynamic(member) ? " [dynamic]" : "";
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

/**
 * Plain-language label for a hole in the tree.
 *
 * One `unresolved: <code>` bucket collided with the documented meaning of the
 * word: "the depth limit stopped here", "this component ships from npm" and
 * "there is JSX in here we could not place" are three different things to do
 * next, and a reader has to be able to tell them apart at a glance.
 */
function unresolvedLabel(reason: UiUnresolvedReason): string {
	switch (reason) {
		case "external-module":
			return "external module";
		case "identifier-unresolved":
			return "unresolved import";
		case "namespaced-component":
			return "namespaced tag";
		case "not-a-function-component":
			return "not a function component";
		case "recursive":
			return "recursion cut";
		case "not-followed":
			return "not followed";
		case "depth-limit-reached":
			return "depth limit";
		case "node-budget-reached":
			return "node budget";
		case "local-render-function":
			return "local render function";
		case "unresolved-jsx":
			return "hole: unresolved-jsx";
		case "opaque-expression":
			return "hole: opaque";
		default:
			return "spread props";
	}
}

/** `slot` for children, `prop <name>` for anything else the caller passed in. */
function placementLabel(placement: NonNullable<UiNode["placement"]>): string {
	return placement.kind === "slot" ? "slot" : `prop ${placement.name}`;
}

/** How one test-id value reads in an outline: a pattern as its prefix + `*`. */
function idLabel(value: UiNode["testId"]): string {
	if (!value) {
		return "-";
	}
	return value.kind === "pattern"
		? `${value.prefix ?? ""}*`
		: (value.value ?? value.raw);
}

function renderUiNode(node: UiNode, indent: string, lines: string[]): void {
	const flags: string[] = [];
	if (node.testId?.kind === "pattern") {
		flags.push(`dynamic ${node.testId.raw}`);
	} else if (node.testId?.kind === "dynamic") {
		flags.push(`dynamic ${node.testId.raw}`);
	}
	// Every branch of a static choice, because the outline is the format an agent
	// actually reads: printing only the first one says `data-testid={big ? "Main"
	// : "Alt"}` renders `Main`, and a selector for `Alt` then looks invented.
	if (node.testIdAlternatives && node.testIdAlternatives.length > 0) {
		flags.push(`or ${node.testIdAlternatives.map(idLabel).join(", ")}`);
	}
	if (node.placement) {
		flags.push(placementLabel(node.placement));
	}
	if (node.conditional) {
		flags.push("conditional");
	}
	if (node.repeated) {
		flags.push("repeated");
	}
	if (node.viaDefault) {
		flags.push("viaDefault");
	}
	// Not "dynamic": the attribute is written and renders nothing here. An agent
	// reading "dynamic" would go looking for the value.
	if (node.testIdAbsent) {
		flags.push("id absent at this site");
	}
	if (node.unresolved) {
		// The expression, where the reason names one: "local render function" says
		// what kind of hole it is, `getCheckinIcon()` says which one to go and read.
		flags.push(
			node.unresolved.raw
				? `${unresolvedLabel(node.unresolved.reason)} ${node.unresolved.raw}`
				: unresolvedLabel(node.unresolved.reason),
		);
	}

	if (node.expandedAt) {
		flags.push(`see ${node.expandedAt.file}:${node.expandedAt.line}`);
	}

	const id = idLabel(node.testId);
	const location = `${node.file}:${node.loc.line}`;
	const flagText = flags.length > 0 ? ` (${flags.join(", ")})` : "";
	lines.push(`${indent}${id}  ${node.tag}  ${location}${flagText}`);

	for (const child of node.children) {
		renderUiNode(child, `${indent}  `, lines);
	}
}

export function renderTestIdOutline(tree: TestIdTree): string {
	const lines: string[] = [];
	if (tree.roots.length === 0) {
		lines.push(`(flat inventory, ${tree.inventory.length} occurrences)`);
		for (const occurrence of tree.inventory) {
			const id =
				occurrence.value.kind === "pattern"
					? `${occurrence.value.prefix ?? ""}*`
					: (occurrence.value.value ?? occurrence.value.raw);
			// Flat is the fallback fidelity, so it is exactly when the per-occurrence
			// metadata the full tree carries matters most.
			const flags: string[] = [];
			if (occurrence.value.kind !== "static") {
				flags.push(`dynamic ${occurrence.value.raw}`);
			}
			if (occurrence.conditional) {
				flags.push("conditional");
			}
			if (occurrence.repeated) {
				flags.push("repeated");
			}
			if (occurrence.viaProp) {
				flags.push(`viaProp ${occurrence.viaProp}`);
			}
			const flagText = flags.length > 0 ? ` (${flags.join(", ")})` : "";
			lines.push(
				`${id}  ${occurrence.tag}  ${occurrence.file}:${occurrence.loc.line}${flagText}`,
			);
		}
		return lines.join("\n");
	}
	for (const root of tree.roots) {
		renderUiNode(root, "", lines);
	}
	return lines.join("\n");
}
