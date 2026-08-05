import type {
	InlinePageObjectNode,
	MemberResult,
	PageObjectNode,
	PageObjectTree,
} from "../types";

export interface InlineOptions {
	maxDepth?: number;
}

const DEFAULT_INLINE_DEPTH = 6;

function childRefs(result: MemberResult): { child?: string; item?: string } {
	switch (result.kind) {
		case "pageObject":
			return result.ref ? { child: result.ref } : {};
		case "control":
			return result.ref ? { child: result.ref } : {};
		case "list":
			return {
				...(result.listRef ? { child: result.listRef } : {}),
				...(result.itemRef ? { item: result.itemRef } : {}),
			};
		default:
			return {};
	}
}

/**
 * Nested projection of the flat `defs` map.
 *
 * A pure post-transform, so the extractor stays cycle-free by construction and
 * both views are unit-testable in isolation. Repeats on the current path become
 * `cyclic: true`; repeats elsewhere become `repeated: true`, keeping the payload
 * linear in the number of definitions rather than exponential.
 */
export function toInlineTree(
	tree: PageObjectTree,
	options: InlineOptions = {},
): InlinePageObjectNode {
	const maxDepth = options.maxDepth ?? DEFAULT_INLINE_DEPTH;
	const emitted = new Set<string>();

	const expand = (
		ref: string,
		depth: number,
		path: Set<string>,
	): InlinePageObjectNode => {
		const def: PageObjectNode | undefined = tree.defs[ref];
		if (!def) {
			return { ref, className: ref.split("#").pop() ?? ref };
		}
		const base: InlinePageObjectNode = {
			ref,
			className: def.className,
			file: def.file,
			hostKind: def.hostKind,
		};
		if (path.has(ref)) {
			return { ...base, cyclic: true };
		}
		if (emitted.has(ref)) {
			return { ...base, repeated: true };
		}
		if (depth >= maxDepth) {
			return { ...base, truncated: true };
		}
		// The extractor stopped at this definition (depth or node budget), so its
		// members' classes were never analysed. Expanding it here would present a
		// stub as a complete subtree.
		if (def.expanded === false) {
			return { ...base, truncated: true };
		}
		emitted.add(ref);

		const nextPath = new Set(path);
		nextPath.add(ref);

		base.members = def.members.map((member) => {
			const refs = childRefs(member.result);
			return {
				name: member.name,
				selector: member.selector,
				result: member.result,
				...(refs.child
					? { child: expand(refs.child, depth + 1, nextPath) }
					: {}),
				...(refs.item ? { item: expand(refs.item, depth + 1, nextPath) } : {}),
			};
		});
		if (def.methods.length > 0) {
			base.methods = def.methods;
		}
		return base;
	};

	return expand(tree.root, 0, new Set<string>());
}
