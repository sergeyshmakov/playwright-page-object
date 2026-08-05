/**
 * Traversal budget shared by the page-object and TSX tree builders.
 *
 * Both trees are built depth-first over user code that may be cyclic or simply
 * enormous, so every expansion asks the budget first and records *why* it
 * stopped. Callers turn `exhausted` into a `truncated: true` flag plus a
 * `depth-limit-reached` / `node-budget-reached` diagnostic.
 */
export class Budget {
	readonly maxNodes: number;
	readonly maxDepth: number;
	private nodes = 0;
	private hitNodeLimit = false;
	private hitDepthLimit = false;

	constructor(maxNodes: number, maxDepth: number) {
		this.maxNodes = Math.max(1, maxNodes);
		this.maxDepth = Math.max(0, maxDepth);
	}

	/** Reserves one node. Returns `false` once the node budget is gone. */
	spend(): boolean {
		if (this.nodes >= this.maxNodes) {
			this.hitNodeLimit = true;
			return false;
		}
		this.nodes += 1;
		return true;
	}

	/** Returns `false` when `depth` is at or past the configured limit. */
	allowsDepth(depth: number): boolean {
		if (depth >= this.maxDepth) {
			this.hitDepthLimit = true;
			return false;
		}
		return true;
	}

	get spent(): number {
		return this.nodes;
	}

	get nodeLimitHit(): boolean {
		return this.hitNodeLimit;
	}

	get depthLimitHit(): boolean {
		return this.hitDepthLimit;
	}

	get exhausted(): boolean {
		return this.hitNodeLimit || this.hitDepthLimit;
	}
}
