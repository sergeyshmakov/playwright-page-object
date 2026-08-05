/**
 * Levenshtein distance, iterative two-row form.
 *
 * Local rather than a dependency: the engine only ever runs it over a handful
 * of short identifiers, and the core package's zero-runtime-dependency rule
 * makes adding `fastest-levenshtein` a poor trade.
 */
export function editDistance(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	if (a.length === 0) {
		return b.length;
	}
	if (b.length === 0) {
		return a.length;
	}

	let previous = new Array<number>(b.length + 1);
	let current = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j += 1) {
		previous[j] = j;
	}

	for (let i = 1; i <= a.length; i += 1) {
		current[0] = i;
		for (let j = 1; j <= b.length; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(
				current[j - 1] + 1,
				previous[j] + 1,
				previous[j - 1] + cost,
			);
		}
		const swap = previous;
		previous = current;
		current = swap;
	}
	return previous[b.length];
}

/**
 * Closest candidates to `target`, best first.
 *
 * The distance ceiling scales with length so `PromoCode` does not "suggest"
 * `SignIn`; a suggestion that is not plausibly a typo is worse than none.
 */
export function nearestIds(
	target: string,
	candidates: Iterable<string>,
	limit = 3,
): string[] {
	const lowered = target.toLowerCase();
	const ceiling = Math.max(2, Math.ceil(target.length / 3));
	const scored: Array<{ id: string; distance: number }> = [];
	for (const candidate of candidates) {
		if (candidate === target) {
			continue;
		}
		const distance = editDistance(lowered, candidate.toLowerCase());
		if (distance <= ceiling) {
			scored.push({ id: candidate, distance });
		}
	}
	scored.sort((a, b) =>
		a.distance === b.distance
			? a.id < b.id
				? -1
				: 1
			: a.distance - b.distance,
	);
	return scored.slice(0, limit).map((entry) => entry.id);
}
