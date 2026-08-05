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
			return `ListPageObject<${result.itemClassName ?? "PageObject"}>`;
		case "control":
			return result.className ?? "control(dynamic)";
		default:
			return "unknown";
	}
}

function memberRef(member: MemberNode): string | null {
	const result = member.result;
	switch (result.kind) {
		case "pageObject":
			return result.ref;
		case "control":
			return result.ref;
		case "list":
			return result.itemRef;
		default:
			return null;
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
			const dynamicMark = member.selector.dynamic ? " [dynamic]" : "";
			lines.push(
				`${indent}  ${member.name} -> ${resultLabel(member)}  ${selectorLabel(member.selector)}${dynamicMark}`,
			);
			const ref = memberRef(member);
			if (ref) {
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
			lines.push(`${id}  ${occurrence.file}:${occurrence.loc.line}`);
		}
		return lines.join("\n");
	}
	for (const root of tree.roots) {
		renderUiNode(root, "", lines);
	}
	return lines.join("\n");
}
