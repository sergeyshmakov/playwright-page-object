import type {
	MaybeStatic,
	MemberNode,
	PageObjectNode,
	PageObjectTree,
	SelectorInfo,
	TestIdTree,
	UiNode,
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

export function renderPageObjectOutline(tree: PageObjectTree): string {
	const lines: string[] = [];
	const visited = new Set<string>();

	function renderDef(id: string, indent: string): void {
		const def: PageObjectNode | undefined = tree.defs[id];
		if (!def) {
			lines.push(`${indent}${id} (unresolved)`);
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
		lines.push(
			`${indent}${def.className} (${def.hostKind})${rootSelector}  ${def.file}`,
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
				renderDef(ref, `${indent}    `);
			}
		}

		if (def.methods.length > 0) {
			const signatures = def.methods.map((method) => method.signature);
			lines.push(`${indent}  methods: ${signatures.join(", ")}`);
		}
	}

	renderDef(tree.root, "");
	return lines.join("\n");
}

function renderUiNode(node: UiNode, indent: string, lines: string[]): void {
	const flags: string[] = [];
	if (node.testId?.kind === "pattern") {
		flags.push(`dynamic ${node.testId.raw}`);
	} else if (node.testId?.kind === "dynamic") {
		flags.push(`dynamic ${node.testId.raw}`);
	}
	if (node.conditional) {
		flags.push("conditional");
	}
	if (node.repeated) {
		flags.push("repeated");
	}
	if (node.unresolved) {
		flags.push(`unresolved: ${node.unresolved.reason}`);
	}

	const id =
		node.testId?.kind === "pattern"
			? `${node.testId.prefix ?? ""}*`
			: (node.testId?.value ?? (node.testId ? node.testId.raw : "-"));
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
