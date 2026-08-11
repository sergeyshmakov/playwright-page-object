import type { PageObjectTree } from "../analysis";

/**
 * The runtime API a selector tree cannot contain.
 *
 * `get_page_object_tree` answers "what does this class declare" exactly, and a
 * reader still cannot write the test body from it. The methods it lists are the
 * class's own by design (see `page-objects/methods.ts`) — the helpers every page
 * object inherits from the library are deliberately not repeated on all 364
 * classes in a repository — so `await guests.rows.first().name.waitText("Ann")`
 * uses four things the payload never mentions: how to construct the root, that
 * a list member has `.first()`, that a page-object member has `.waitText`, and
 * that a `Locator` member has neither because it is already a Locator.
 *
 * A field test of the tools against a production suite found precisely this
 * gap: every selector and every nesting correct, and the runtime API present in
 * the repository's real specs and nowhere in the tool surface. So the tree
 * ships the call syntax next to the chain, as a few static lines chosen by what
 * the tree actually contains — an agent that has the shape and the syntax in
 * one response does not have to go and read the package README to use either.
 *
 * Static text, not analysis: these are this package's own exports, and a line
 * here is wrong only if the library changes. `src/tests/mcp/api.spec.ts` holds
 * them to the runtime classes so they cannot drift.
 */

/** A surface worth explaining, keyed by what makes it appear in a tree. */
export type ApiSurface =
	| "members"
	| "RootPageObject"
	| "PageObject"
	| "ListPageObject";

/**
 * One line each, in reading order: how to reach a member, how to get the root
 * object at all, then the two bases that supply the methods.
 */
const API_LINES: Record<ApiSurface, string> = {
	members:
		'Every member listed here is a property: `po.CartItems`. A member whose result is `Locator` IS a Playwright Locator - call Playwright on it directly (`po.PromoCodeInput.fill("SAVE20")`). Every other member is a page object, and its raw locator is `.$` (`po.ApplyPromoButton.$.click()`).',
	RootPageObject:
		"Built from the Playwright page: `const po = new CheckoutPage(page)`. If the node lists `fixtures`, that binding already exists - take it as a test argument instead (`test(..., async ({ checkoutPage }) => ...)`), bound by `createFixtures({ checkoutPage: CheckoutPage })`.",
	PageObject:
		"`.$` is the Playwright Locator (`.click()`, `.fill()`, `.textContent()`, ...). Awaitable waits: `.waitVisible() .waitHidden() .waitText(t) .waitValue(v) .waitCount(n) .waitChecked() .waitUnChecked()`. `.expect({soft?, message?})` returns Playwright's `expect(locator)` for any other assertion, and `.page` is the `Page`.",
	ListPageObject:
		"One item: `.first() .second() .last() .at(i) .getItemByIndex(i)` (negative `i` counts from the end), `.getItemByText(t)`, `.getItemByTestId(id)` (the item's own id), `.getItemByRole(...)`. A narrowed list: `.filter(opts) .filterByText(t) .filterByItemTestId(id)` (own id) `.filterByHasTestId(id)` (a descendant's). The whole list: `await .count()`, `await .getAll()`, `.items[i]`, and `for await (const item of list.items)` - `.items` is async-iterable only.",
};

/** Fixed emission order, so two responses never disagree about it. */
const API_ORDER: ApiSurface[] = [
	"members",
	"RootPageObject",
	"PageObject",
	"ListPageObject",
];

/**
 * The API lines this tree needs, or `undefined` when it needs none.
 *
 * Chosen from the shipped nodes rather than from the root's own base class,
 * because the base a *member* resolves to is the one an agent is about to call:
 * a `RootPageObject` whose rows are a `ListPageObject<GuestRow>` needs all
 * three lines, and a plain host that extends nothing still hands out members
 * that are library page objects. Both `inheritedApi` (what a node extends) and
 * the member result kinds (what a member evaluates to) feed the set, so a base
 * whose stub the depth limit cut is still explained.
 */
export function apiHintsFor(
	tree: PageObjectTree,
): Partial<Record<ApiSurface, string>> | undefined {
	const wanted = new Set<ApiSurface>();

	for (const def of Object.values(tree.defs)) {
		if (def.inheritedApi) {
			wanted.add(def.inheritedApi);
			// Both of the others extend it, and every wait/assert helper lives there.
			wanted.add("PageObject");
		}
		if (def.members.length > 0) {
			wanted.add("members");
		}
		for (const member of def.members) {
			if (member.result.kind === "list") {
				wanted.add("ListPageObject");
				// The items are page objects whatever the list class is.
				wanted.add("PageObject");
			} else if (
				member.result.kind === "pageObject" ||
				member.result.kind === "control"
			) {
				wanted.add("PageObject");
			}
		}
	}

	if (wanted.size === 0) {
		return undefined;
	}
	return Object.fromEntries(
		API_ORDER.filter((surface) => wanted.has(surface)).map((surface) => [
			surface,
			API_LINES[surface],
		]),
	);
}
