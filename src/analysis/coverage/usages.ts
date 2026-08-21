import { Node, SyntaxKind } from "ts-morph";
import type { discoverInternal } from "../page-objects/discover";
import { readExpressionValue } from "../tsx/scanTestIds";
import type { SelectorInfo, SelectorUsage, SourceLoc } from "../types";
import { lexicalDeclaration, unwrapTransparent } from "../util/ast";
import { literalPrefixOf, parseRegexLiteral } from "../util/literal";
import { keyFold, matchesAnyGlob } from "../util/paths";
import type { Workspace } from "../workspace";

/** Locator calls whose first argument is a test id. */
const RAW_CALL_NAMES = new Set([
	"getByTestId",
	"getItemByTestId",
	"filterByItemTestId",
	"filterByHasTestId",
]);

/**
 * Cheap pre-filter for the raw sweep: every call name above contains it.
 *
 * The sweep reads the same files discovery does, which in a real repository is
 * thousands. Descending into every `CallExpression` of every one of them costs
 * more than the rest of the report put together; a substring test on the file
 * text skips the overwhelming majority for the price of a scan.
 */
const RAW_CALL_MARKER = "TestId";

/**
 * Where a selector usage comes from: the page objects the scope selected,
 * and the direct `getByTestId`-family calls swept out of the sources.
 *
 * Split out of `mapCoverage.ts`, which keeps the pipeline that assembles a
 * report from these parts.
 */

/**
 * Builds `memberPath` prefixes by walking from the root page objects outward,
 * so a nested control reads as `CheckoutPage.CartItems[item].RemoveButton`
 * rather than as a bare class name.
 */
function assignPaths(
	discovery: ReturnType<typeof discoverInternal>,
): Map<string, string> {
	const paths = new Map<string, string>();
	const roots = [...discovery.classes.values()]
		.filter((entry) => {
			const kind = entry.classification.hostKind;
			return (
				kind === "rootPageObject" ||
				kind === "rootPlain" ||
				kind === "pageFallback" ||
				(discovery.fixtures.byClass.get(entry.foldedKey)?.length ?? 0) > 0
			);
		})
		.sort((a, b) => (a.className < b.className ? -1 : 1));

	const queue: Array<{ key: string; path: string }> = [];
	for (const root of roots) {
		if (!paths.has(root.foldedKey)) {
			paths.set(root.foldedKey, root.className);
			queue.push({ key: root.foldedKey, path: root.className });
		}
	}

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) {
			break;
		}
		const entry = discovery.classes.get(current.key);
		if (!entry) {
			continue;
		}
		for (const read of entry.members) {
			const result = read.member.result;
			for (const edge of read.edges) {
				const folded = keyFold(edge.ref);
				if (paths.has(folded) || !discovery.classes.has(folded)) {
					continue;
				}
				const isItem = result.kind === "list" && result.itemRef === edge.ref;
				const childPath = isItem
					? `${current.path}.${read.member.name}[item]`
					: `${current.path}.${read.member.name}`;
				paths.set(folded, childPath);
				queue.push({ key: folded, path: childPath });
			}
		}
	}

	return paths;
}

export function collectSelectorUsages(
	discovery: ReturnType<typeof discoverInternal>,
): SelectorUsage[] {
	const paths = assignPaths(discovery);
	const usages: SelectorUsage[] = [];

	for (const entry of discovery.classes.values()) {
		const prefix = paths.get(entry.foldedKey) ?? entry.className;

		if (entry.rootSelector) {
			usages.push(
				// The decorator's own line, captured in discovery. It used to be
				// hardcoded to 0, which is not a line: an agent following a matched
				// root selector's location landed nowhere.
				toUsage(
					entry.key,
					prefix,
					entry.rootSelector,
					entry.rootSelectorLoc ?? { file: entry.file, line: 1 },
				),
			);
		}
		for (const read of entry.members) {
			usages.push(
				toUsage(
					entry.key,
					`${prefix}.${read.member.name}`,
					read.member.selector,
					read.member.loc,
				),
			);
		}
	}

	return usages;
}

/**
 * Exact test-id selectors embedded in `locator()` expressions of page objects.
 *
 * A composed selector often keeps one static attribute in a local constant and
 * another in the outer template: ``locator(`${row} [data-testid="Cell"]`)``.
 * Reading only the final expression loses both. Literal fragments plus one
 * local-identifier hop preserve the static evidence without pretending a
 * dynamic interpolation names an id.
 */
export function collectComposedLocatorUsages(
	discovery: ReturnType<typeof discoverInternal>,
	attribute: string,
): SelectorUsage[] {
	const usages: SelectorUsage[] = [];
	const seenDeclarations = new Set<string>();
	const seenUsages = new Set<string>();
	for (const entry of discovery.classes.values()) {
		if (seenDeclarations.has(entry.key)) {
			continue;
		}
		seenDeclarations.add(entry.key);
		for (const call of entry.declaration.getDescendantsOfKind(
			SyntaxKind.CallExpression,
		)) {
			if (rawCallName(call) !== "locator") {
				continue;
			}
			const [argument] = call.getArguments();
			if (!argument) {
				continue;
			}
			const ids = new Set<string>();
			for (const fragment of stringFragments(argument, new Set())) {
				for (const id of exactAttributeIds(fragment, attribute)) {
					ids.add(id);
				}
			}
			if (ids.size === 0) {
				continue;
			}
			const loc = discovery.ctx.ws.loc(call);
			const method = call.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
			for (const id of ids) {
				const key = `${entry.key}:${loc.line}:${loc.column ?? 0}:${id}`;
				if (seenUsages.has(key)) {
					continue;
				}
				seenUsages.add(key);
				usages.push({
					defId: entry.key,
					memberPath: method
						? `${entry.className}.${method.getName()}`
						: `${entry.className}.locator`,
					loc,
					kind: "testId",
					text: call.getText().replace(/\s+/g, " ").slice(0, 200),
					testId: id,
					dynamic: false,
					origin: "raw",
				});
			}
		}
	}
	return usages;
}

function stringFragments(node: Node, seen: Set<string>): string[] {
	const expression = unwrapTransparent(node);
	if (
		Node.isStringLiteral(expression) ||
		Node.isNoSubstitutionTemplateLiteral(expression)
	) {
		return [expression.getLiteralText()];
	}
	if (Node.isTemplateExpression(expression)) {
		const fragments = [expression.getHead().getLiteralText()];
		for (const span of expression.getTemplateSpans()) {
			fragments.push(...stringFragments(span.getExpression(), seen));
			fragments.push(span.getLiteral().getLiteralText());
		}
		return fragments;
	}
	if (
		Node.isBinaryExpression(expression) &&
		expression.getOperatorToken().getKind() === SyntaxKind.PlusToken
	) {
		return [
			...stringFragments(expression.getLeft(), seen),
			...stringFragments(expression.getRight(), seen),
		];
	}
	if (!Node.isIdentifier(expression)) {
		return [];
	}
	const declaration =
		lexicalDeclaration(expression, expression.getText()) ??
		expression
			.getSourceFile()
			.getVariableDeclarations()
			.find((candidate) => candidate.getName() === expression.getText());
	if (!declaration || !Node.isVariableDeclaration(declaration)) {
		return [];
	}
	const key = `${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}`;
	if (seen.has(key)) {
		return [];
	}
	seen.add(key);
	const initializer = declaration.getInitializer();
	return initializer ? stringFragments(initializer, seen) : [];
}

function exactAttributeIds(fragment: string, attribute: string): string[] {
	const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const selector = new RegExp(
		`\\[\\s*${escaped}\\s*=\\s*(["'])([^"'\\]]+)\\1\\s*\\]`,
		"g",
	);
	return [...fragment.matchAll(selector)].map((match) => match[2] ?? "");
}

function toUsage(
	defId: string,
	memberPath: string,
	selector: SelectorInfo,
	loc: SourceLoc,
): SelectorUsage {
	const usage: SelectorUsage = {
		defId,
		memberPath,
		loc,
		kind: selector.kind,
		text: selector.raw,
		dynamic: selector.dynamic,
		origin: "page-object",
	};
	if (selector.kind === "testId" && typeof selector.testId === "string") {
		usage.testId = selector.testId;
	}
	if (selector.kind === "testIdPattern" && selector.pattern) {
		usage.pattern = selector.pattern;
	}
	return usage;
}

/** The call name, whether written as `page.getByTestId` or bare. */
function rawCallName(call: Node): string | null {
	if (!Node.isCallExpression(call)) {
		return null;
	}
	const callee = call.getExpression();
	if (Node.isPropertyAccessExpression(callee)) {
		return callee.getName();
	}
	if (Node.isIdentifier(callee)) {
		return callee.getText();
	}
	return null;
}

/**
 * Direct locator calls anywhere in the analysed sources.
 *
 * Two things were wrong with sweeping `*.spec.ts` for `getByTestId` alone. The
 * file filter assumed a naming convention — a repository whose Playwright tests
 * live in `checkout.e2e.ts`, or whose selectors sit in a helper module, got a
 * report claiming ids were unused when a call site was three lines away. And
 * `getByTestId` is one of four call names this library's own list page object
 * exposes, so `filterByHasTestId("Row")` counted for nothing.
 *
 * The argument is read with the same reader the JSX scan uses, so a template
 * literal becomes a pattern instead of being dropped, and an expression nobody
 * can evaluate becomes an honest `unknown` instead of silence.
 */
export function sweepRawLocators(
	ws: Workspace,
	poInclude: string[] | undefined,
): SelectorUsage[] {
	const usages: SelectorUsage[] = [];
	for (const sourceFile of ws.sourceFiles()) {
		const rel = ws.rel(sourceFile.getFilePath());
		if (poInclude && poInclude.length > 0 && !matchesAnyGlob(rel, poInclude)) {
			continue;
		}
		if (!sourceFile.getFullText().includes(RAW_CALL_MARKER)) {
			continue;
		}
		for (const call of sourceFile.getDescendantsOfKind(
			SyntaxKind.CallExpression,
		)) {
			const name = rawCallName(call);
			if (name === null || !RAW_CALL_NAMES.has(name)) {
				continue;
			}
			const [argument] = call.getArguments();
			if (!argument) {
				continue;
			}
			const loc = ws.loc(call);
			const base = {
				defId: rel,
				memberPath: `${rel}:${loc.line}`,
				loc,
				text: call.getText().replace(/\s+/g, " ").slice(0, 200),
				origin: "raw" as const,
			};

			if (Node.isRegularExpressionLiteral(argument)) {
				const regex = parseRegexLiteral(argument.getText());
				usages.push({
					...base,
					kind: "testIdPattern",
					pattern: {
						source: regex.source,
						flags: regex.flags,
						origin: "regex",
						matchMode: "regex",
						literalPrefix: literalPrefixOf(regex.source),
					},
					dynamic: false,
				});
				continue;
			}

			// Every branch, not just the first. `getByTestId(big ? "A" : "B")`
			// selects one of two ids and the reader kept only "A", so "B" came back
			// uncovered even though a locator names it — and a typo'd branch never
			// reached deadSelectors, because the sweep never saw it. The JSX side of
			// the same reader has always handled a static choice this way.
			for (const value of readExpressionValue(argument).values) {
				if (value.kind === "static" && value.value !== undefined) {
					usages.push({
						...base,
						kind: "testId",
						testId: value.value,
						dynamic: false,
					});
					continue;
				}
				if (value.kind === "pattern" && value.regex) {
					usages.push({
						...base,
						kind: "testIdPattern",
						pattern: {
							source: value.regex.source,
							flags: value.regex.flags,
							origin: "string",
							matchMode: "regex",
							literalPrefix:
								value.prefix ?? literalPrefixOf(value.regex.source) ?? null,
						},
						dynamic: false,
					});
					continue;
				}
				usages.push({
					...base,
					kind: "testId",
					dynamic: true,
					reason:
						value.kind === "dynamic" ? value.reason : "computed-expression",
				});
			}
		}
	}
	return usages;
}
