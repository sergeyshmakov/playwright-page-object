import type { TestIdOccurrence, UiTestId } from "../types";
import { isCatchAllPattern } from "./match";

/**
 * The four buckets every rendered test id falls into, and which of them a
 * selector may be matched against.
 *
 * Split out of `mapCoverage.ts`, which keeps the pipeline that assembles a
 * report from these parts.
 */

export interface InventoryPartition {
	/** Ids proven to reach the DOM, grouped. Only these are matchable. */
	rendered: UiTestId[];
	/** Ids written as a prop on a component tag, with no forwarding proven. */
	prop: UiTestId[];
	/** Patterns that match every id, quarantined before they can match one. */
	catchAll: TestIdOccurrence[];
	/** Values that are not statically knowable at all. */
	dynamic: TestIdOccurrence[];
}

function addTo(
	byKey: Map<string, UiTestId>,
	key: string,
	occurrence: TestIdOccurrence,
	make: () => UiTestId,
	promoted: boolean,
): void {
	const existing = byKey.get(key);
	if (existing) {
		existing.occurrences.push(occurrence);
		// One genuinely rendered occurrence is enough: the group no longer owes its
		// existence to the assumption, so it must not be labelled as if it did.
		if (!promoted) {
			existing.assumed = undefined;
		}
		return;
	}
	const entry = make();
	if (promoted) {
		entry.assumed = true;
	}
	byKey.set(key, entry);
}

/**
 * Splits the flat inventory into the four states coverage can distinguish.
 *
 * Four, not two, because "rendered" and "not rendered" cannot express the two
 * cases that actually cause wrong reports: an id nobody has proven reaches the
 * DOM, and a pattern so loose it matches everything. Counting the first as
 * rendered invents coverage; matching against the second invents it wholesale.
 */
export function partitionInventory(
	inventory: TestIdOccurrence[],
	assumeForwarded = false,
): InventoryPartition {
	const renderedByKey = new Map<string, UiTestId>();
	const propByKey = new Map<string, UiTestId>();
	const catchAll: TestIdOccurrence[] = [];
	const dynamic: TestIdOccurrence[] = [];

	for (const occurrence of inventory) {
		const value = occurrence.value;
		const isProp = occurrence.reach === "component-prop";
		const promoted = isProp && assumeForwarded;
		const target = isProp && !assumeForwarded ? propByKey : renderedByKey;

		if (value.kind === "static" && value.value !== undefined) {
			const id = value.value;
			addTo(
				target,
				`s:${id}`,
				occurrence,
				() => ({
					id,
					patternSource: null,
					prefix: id,
					occurrences: [occurrence],
				}),
				promoted,
			);
			continue;
		}
		if (value.kind === "pattern" && value.regex) {
			if (isCatchAllPattern(value.regex.source)) {
				catchAll.push(occurrence);
				continue;
			}
			const regex = value.regex;
			addTo(
				target,
				`p:${regex.source}`,
				occurrence,
				() => ({
					id: null,
					patternSource: regex.source,
					patternFlags: regex.flags,
					prefix: value.prefix ?? null,
					occurrences: [occurrence],
				}),
				promoted,
			);
			continue;
		}
		dynamic.push(occurrence);
	}

	return {
		rendered: [...renderedByKey.values()],
		prop: [...propByKey.values()],
		catchAll,
		dynamic,
	};
}
