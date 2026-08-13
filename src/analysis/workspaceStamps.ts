import * as fs from "node:fs";
import * as path from "node:path";
import {
	locateTsConfig,
	tsConfigChain,
	tsConfigWildcardDirectories,
} from "./config/tsconfig";
import { globStaticBase } from "./util/paths";
import { configDirOf } from "./workspaceBuild";

/**
 * Owns the ts-morph `Project` for one analysed root.
 *
 * Invalidation is an mtime sweep per call rather than `fs.watch`: it is
 * stateless, survives branch switches and bulk checkouts, needs no debounce,
 * and behaves on network or virtualised filesystems where watch events are
 * unreliable.
 */
import { WorkspaceFiles } from "./workspaceFiles";

/**
 * Whether the workspace is still the right one to be asking.
 *
 * Four stamps, taken when the project is built and compared on every acquire:
 * the tsconfig and its whole `extends` chain, the Playwright config's
 * `testDir`, the lockfile, and the mtimes of the scanned directories. Between
 * them they cover every input that decided which files the `Project` holds and
 * how they parse - none of which the mtime sweep can revisit, because the file
 * set was settled at construction.
 *
 * The middle of the class rather than a collaborator of it: comparing a stamp
 * means reading the config the base caches and the mtime map the base
 * maintains, and the five fields here exist for nothing else.
 */

/**
 * Stamp for a scan root that was not on disk at the last sweep.
 *
 * Negative, so it can never equal an `mtimeMs`, which makes the transition to a
 * real stamp compare unequal and register as a change — the point being that a
 * scan directory coming into existence is exactly as significant as one whose
 * contents moved.
 */
const MISSING_DIR = -1;

/**
 * How far above the analysed root to look for the lockfile that governs it.
 *
 * A backstop only - the walk normally stops at the first lockfile or at the
 * `.git` boundary, both of which are within a hop or two of any real package.
 */
const MAX_LOCKFILE_ANCESTORS = 16;

/** Every lockfile the four package managers write, stat'ed as one signal. */
const LOCKFILE_NAMES = [
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
];

/** A file's mtime as a comparable string, or a stable marker when it is gone. */
function mtimeOf(filePath: string): string {
	try {
		return String(fs.statSync(filePath).mtimeMs);
	} catch {
		return "missing";
	}
}

export class WorkspaceStamps extends WorkspaceFiles {
	/**
	 * Fingerprint of the inputs that decided what this `Project` *is*, as of the
	 * last acquire. See {@link projectIdentity}.
	 */
	private identity: string | null = null;
	/** Summed lockfile mtimes as of the last sweep. See {@link lockfileChanged}. */
	private lockfileStamp: number | null = null;
	/** Last known mtime per scanned directory. See {@link scanDirsChanged}. */
	private readonly scanDirMtimes = new Map<string, number>();
	/** The tsconfig's wildcard directories, cached against its own mtime. */
	private wildcardDirs: {
		root: string;
		stamp: string;
		paths: string[];
	} | null = null;
	/**
	 * The located tsconfig's `extends` chain, cached against the root's own mtime
	 * so {@link projectIdentity} stats the chain per acquire but only re-reads it
	 * when the root changes.
	 */
	private tsconfigChain: {
		root: string;
		rootStamp: string;
		paths: string[];
	} | null = null;

	/**
	 * The inputs that decided which files this `Project` holds and how they parse.
	 *
	 * Not the same question as "did a source file change". The mtime sweep keeps
	 * the *contents* of the file set current and can add or drop files the globs
	 * already cover, but the set itself — which tsconfig supplied the compiler
	 * options, which directory the scan was rooted at — was fixed at construction.
	 * Edit `testDir` in `playwright.config.ts` and every later call answers from a
	 * project built for the old one: the right shape of answer, about the wrong
	 * directory, with nothing saying so.
	 *
	 * Idle eviction does not cover this. `touch()` restarts on every acquire, so
	 * the timer measures silence, and an agent that edits a config and immediately
	 * asks again is the opposite of silent — it keeps the stale project for the
	 * whole working burst, which is exactly when it is being read.
	 *
	 * `null` when it cannot be read at all — reading it parses the Playwright
	 * config, and on a repository at its file cap that parse is exactly what
	 * `maxFiles` refuses. Failing to answer must not turn into an answer, and it
	 * must not move that refusal into `acquire`: the tool call raises it where it
	 * always did.
	 */
	private projectIdentity(): string | null {
		if (this.inMemory) {
			return "";
		}
		try {
			const playwright = this.playwright();
			// Same rule as `create`: an unresolved `testDir` is left unknown rather
			// than replaced by the config's own directory.
			const testDir = playwright.testDirUnresolved
				? undefined
				: (playwright.testDir ?? configDirOf(playwright.configFile));
			const located = locateTsConfig(this.root, this.options.tsconfig, testDir);
			// The tsconfig's mtime as well as its path: `include`, `exclude` and
			// `paths` all decide the file set, and editing them in place leaves the
			// path identical. And the whole `extends` chain, not just the located
			// file — a shared base is where a monorepo keeps `paths` and half its
			// `include`, so watching only the leaf left an edit to the base
			// invisible.
			//
			// The chain itself is only re-read when the root's own mtime moves;
			// every other acquire just stats the paths it already knows. Re-parsing
			// a config stack on the hot path would be a real cost, and the root's
			// mtime is exactly what changes when its `extends` list does.
			let stamp = "";
			if (located.path) {
				const rootStamp = mtimeOf(located.path);
				if (
					this.tsconfigChain === null ||
					this.tsconfigChain.root !== located.path ||
					this.tsconfigChain.rootStamp !== rootStamp
				) {
					this.tsconfigChain = {
						root: located.path,
						rootStamp,
						paths: tsConfigChain(located.path),
					};
				}
				stamp = this.tsconfigChain.paths.map(mtimeOf).join(",");
			}
			return [testDir ?? "", located.path ?? "", stamp].join("::");
		} catch {
			return null;
		}
	}

	/**
	 * Whether any directory the scan covers has changed since the last check.
	 *
	 * Two sources, because neither alone is enough:
	 *
	 * - Every directory that currently holds a project file, from the keys of
	 *   {@link mtimes} - free, since the sweep maintains that map anyway. Covers a
	 *   file appearing beside files already loaded, and a whole new subdirectory,
	 *   which bumps its existing parent.
	 * - The scan roots themselves, so a file landing in a root that holds no
	 *   loaded source is still seen.
	 *
	 * Not exhaustive, and the timer is why that is acceptable: a file created in a
	 * pre-existing *nested* directory holding no loaded source is still missed
	 * until the window elapses. Catching that exactly needs a recursive watcher.
	 * One second late is the worst case; before this it was "until something else
	 * changed".
	 */
	protected scanDirsChanged(): boolean {
		if (this.inMemory) {
			return false;
		}
		const directories = new Set<string>(this.scanRoots());
		for (const filePath of this.mtimes.keys()) {
			directories.add(path.dirname(filePath));
		}
		// The project root, whether or not anything is scanned there, and the
		// directories holding the configs already found.
		//
		// This gate gets `rediscoverConfigs()` as well as the re-glob, and config
		// discovery does not follow the scan scope: a server scoped to `src` finds
		// `playwright.config.ts` at the root. Watching only scan roots and the
		// directories of loaded sources meant a config *appearing* at the root was
		// invisible for the throttle window, so the next call kept the old
		// `testIdAttribute` and `testDir` while promising results reflect the disk.
		directories.add(this.root);
		for (const candidate of this.discovery?.candidates ?? []) {
			directories.add(path.dirname(path.resolve(candidate)));
		}
		// Per directory, not a sum over the set, and only directories already known
		// count as evidence. The set *grows* on its own as the resolver pulls files
		// in on demand, so a summed stamp changed on almost every call and the
		// re-glob it is supposed to gate ran every time - measured at 5-8% slower
		// across the board on a 4,924-file repository, for a signal that was
		// reporting the project loading rather than the disk changing.
		//
		// A genuinely new directory needs no special case: creating `src/new/`
		// bumps the mtime of `src`, which is already known.
		let changed = false;
		const seen = new Set<string>();
		for (const directory of directories) {
			let stamp: number;
			try {
				stamp = fs.statSync(directory).mtimeMs;
			} catch {
				// Not there. Remembered as such rather than skipped: a scan root that
				// does not exist yet is the one case where *appearing* is the change,
				// and dropping it here meant the first call after `mkdir e2e` fell
				// back on the re-glob throttle instead of defeating it.
				seen.add(directory);
				this.scanDirMtimes.set(directory, MISSING_DIR);
				continue;
			}
			seen.add(directory);
			const previous = this.scanDirMtimes.get(directory);
			if (previous !== undefined && previous !== stamp) {
				changed = true;
			}
			this.scanDirMtimes.set(directory, stamp);
		}
		for (const directory of this.scanDirMtimes.keys()) {
			if (!seen.has(directory)) {
				this.scanDirMtimes.delete(directory);
			}
		}
		return changed;
	}

	/**
	 * The directories the scan is anchored at.
	 *
	 * For a tsconfig-backed project, its `wildcardDirectories` - TypeScript
	 * computes them for exactly this purpose and they are the only place the
	 * scan's *directories*, as opposed to its files, are written down. Cached
	 * against the tsconfig's own mtime, so the parse behind them is not repeated
	 * per call.
	 */
	private scanRoots(): string[] {
		const include = this.options.include ?? [];
		if (include.length > 0) {
			return include
				.filter((pattern) => !pattern.startsWith("!"))
				.map((pattern) =>
					path.resolve(this.root, globStaticBase(pattern) || "."),
				);
		}
		if (!this.tsconfigPath) {
			return [this.root];
		}
		const stamp = mtimeOf(this.tsconfigPath);
		if (
			this.wildcardDirs === null ||
			this.wildcardDirs.root !== this.tsconfigPath ||
			this.wildcardDirs.stamp !== stamp
		) {
			this.wildcardDirs = {
				root: this.tsconfigPath,
				stamp,
				paths: tsConfigWildcardDirectories(this.tsconfigPath),
			};
		}
		return this.wildcardDirs.paths.length > 0
			? this.wildcardDirs.paths
			: [this.root];
	}

	protected rememberProjectIdentity(): void {
		this.identity = this.projectIdentity();
	}

	/**
	 * Whether a package install has happened since the last sweep.
	 *
	 * The lockfile stands in for the whole of `node_modules`: it is one file, it
	 * is rewritten by every install across npm, yarn, pnpm and bun, and the
	 * alternative — walking a dependency tree on every tool call — is not
	 * something this can afford. Missing entirely is a stable state, not a
	 * change, so a repository with no lockfile never bumps on this.
	 *
	 * The analysed root's, and the nearest ancestor's above it.
	 *
	 * "A package below the root sees the change on its own lockfile" was wrong
	 * about how workspaces work: npm, yarn and pnpm all keep one lockfile at the
	 * repository root and none in the packages. So a server rooted at
	 * `apps/web` — the normal way to run this on a monorepo — stat'ed nothing
	 * that any install ever touches, and a `pnpm install` that relinked a package
	 * left every resolver cache from before it in place, still calling first-party
	 * source an external dependency, for the rest of the session.
	 */
	protected lockfileChanged(): boolean {
		let stamp = 0;
		for (const directory of this.lockfileDirectories()) {
			for (const name of LOCKFILE_NAMES) {
				try {
					stamp += fs.statSync(path.join(directory, name)).mtimeMs;
				} catch {
					// Absent: contributes nothing, and stays contributing nothing.
				}
			}
		}
		const previous = this.lockfileStamp;
		this.lockfileStamp = stamp;
		// The first sweep establishes the baseline rather than reporting a change.
		return previous !== null && previous !== stamp;
	}

	/**
	 * Where a lockfile that governs this root could live: the root itself, and
	 * the nearest ancestor holding one.
	 *
	 * Only the nearest: a monorepo has exactly one lockfile above a package, so
	 * finding the first is finding it. The walk stops there, or at the repository
	 * boundary — going past `.git` would stat a user's home directory every sweep
	 * and could only ever find a lockfile belonging to something else.
	 *
	 * Deliberately not cached, which the first version of this got wrong. A
	 * negative result is not stable: a monorepo whose lockfile does not exist
	 * when the server starts gets one on the next install, and a cache would
	 * never look again. What is left is a handful of stats that stop at the first
	 * hit, which is cheaper than being wrong for the rest of the session.
	 *
	 * Deliberately not cached. A negative result is not stable: a monorepo whose
	 * lockfile does not exist when the server starts gets one on the next
	 * install, and a cache would never look again. The walk is a handful of stats
	 * that stops at the first lockfile or at the repository boundary, so paying
	 * it per sweep is cheaper than being wrong for the rest of the session.
	 */
	private lockfileDirectories(): string[] {
		const directories = [this.root];
		let current = path.dirname(this.root);
		for (let hop = 0; hop < MAX_LOCKFILE_ANCESTORS; hop += 1) {
			const here = current;
			const hasLockfile = LOCKFILE_NAMES.some(
				(name) => mtimeOf(path.join(here, name)) !== "missing",
			);
			if (hasLockfile) {
				directories.push(here);
				break;
			}
			// The repository boundary. Walking past it would stat a user's home
			// directory on every sweep and could only ever find a lockfile that has
			// nothing to do with this project.
			if (mtimeOf(path.join(here, ".git")) !== "missing") {
				break;
			}
			const parent = path.dirname(here);
			if (parent === here) {
				break;
			}
			current = parent;
		}
		return directories;
	}

	/** Whether {@link projectIdentity} has moved since the last acquire. */
	protected projectIdentityChanged(): boolean {
		const current = this.projectIdentity();
		// Unreadable now, or never read: either way there is nothing to compare,
		// and reusing the project is the answer that changes nothing.
		if (current === null) {
			return false;
		}
		if (this.identity === null || this.identity === current) {
			this.identity = current;
			return false;
		}
		this.identity = current;
		return true;
	}
}
