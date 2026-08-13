import { Node } from "ts-morph";
import type { TestIdAttributeOrigin } from "../types";
import {
	type ConfigLayer,
	type ConfigProperty,
	getProperty,
	type LayerContext,
	layersFromExpression,
	stringLiteralValue,
} from "./configLayers";

/**
 * Reading one property out of a layer stack, and saying when a value was found
 * but cannot be vouched for.
 *
 * The rule that makes this more than a lookup: a layer that *writes* the
 * property stops the walk even when its value is unreadable, because a lower
 * layer's value is not what Playwright would use.
 */

type ScalarRead =
	| { state: "found"; value: string; layer: ConfigLayer; node: Node }
	| {
			state: "unresolved";
			layer: ConfigLayer;
			node: Node;
			/** `"occluded"`: a literal value that an unfollowable spread may replace. */
			reason?: "occluded";
	  }
	| { state: "absent" };

/**
 * Highest precedence wins, and a layer that *writes* the property stops the
 * walk even when the written value is not a literal.
 *
 * That last part is the whole point: `use: { testIdAttribute: process.env.X }`
 * in the leaf config is positive evidence that the base config's value is not
 * what runs, so falling through to it would report a value the suite never
 * uses. Unknown is reported as unknown.
 */
export function readLayered(
	layers: ConfigLayer[],
	pick: (layer: ConfigLayer) => ConfigProperty | undefined,
): ScalarRead {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		const property = pick(layer);
		if (!property) {
			continue;
		}
		// A shorthand has no initializer to read. `use: { testIdAttribute }` used to
		// be dropped by the collector entirely, so the whole analysis ran against
		// the default attribute with nothing said about it - the one config mistake
		// that silently invalidates every id in the report. It is a write like any
		// other now, and an unreadable one, so it stops the walk and says so.
		const initializer = Node.isPropertyAssignment(property)
			? property.getInitializer()
			: undefined;
		const value = stringLiteralValue(initializer);
		if (value === undefined) {
			return { state: "unresolved", layer, node: initializer ?? property };
		}
		if (layer.occluded) {
			// A literal, read, and still not an answer: an unfollowable spread is
			// written above it, and in JavaScript that spread wins. Reporting the
			// value would be a coin flip presented as a fact.
			return {
				state: "unresolved",
				layer,
				node: initializer ?? property,
				reason: "occluded",
			};
		}
		return { state: "found", value, layer, node: initializer ?? property };
	}
	return { state: "absent" };
}

/**
 * The property this *layer* contributes under `name`, if any.
 *
 * Scoped to the layer's own slice rather than to the whole literal: a property
 * written after a spread belongs to a higher layer than one written before it,
 * and asking the literal would hand both to whichever layer asked first. The
 * last assignment in the slice wins, as it does in JavaScript.
 */
export function layerProperty(
	layer: ConfigLayer,
	name: string,
): ConfigProperty | undefined {
	for (let index = layer.properties.length - 1; index >= 0; index -= 1) {
		const property = layer.properties[index];
		if (property.getName() === name) {
			return property;
		}
	}
	return undefined;
}

/**
 * Reads `use.testIdAttribute` across the stack, layering the nested object too.
 *
 * `use` is a config object in its own right: it can spread another one, be an
 * imported constant, or be assembled by a helper. Looking the key up directly on
 * the literal reported `"data-leaf"` for
 * `use: { testIdAttribute: "data-leaf", ...baseUse }`, where JavaScript gives
 * the trailing spread the last word — so the nested object goes through the same
 * {@link objectLayers} splitting the top level does, and the same
 * highest-layer-wins walk reads it.
 *
 * The other half is what an *absent* key means. A `use` reached through a spread
 * replaces the `use` of everything below it, key or no key, so the walk stops
 * there; one reached as a merge argument only overrides the keys it names, so
 * the walk continues. {@link ConfigLayer.useShallow} is which of the two applies.
 */
export function readTestIdAttribute(
	layers: ConfigLayer[],
	ctx: LayerContext,
): ScalarRead {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		const property = layerProperty(layer, "use");
		if (!property) {
			continue;
		}
		const initializer = Node.isPropertyAssignment(property)
			? property.getInitializer()
			: undefined;
		const nested = initializer
			? layersFromExpression(
					{
						expression: initializer,
						sourceFile: layer.sourceFile,
						depth: layer.depth,
						origin: layer.origin,
						// The gap inside `use` is reported by the attribute's own notes,
						// not as one more unreadable merge argument.
						quiet: true,
						useShallow: false,
						occluded: layer.occluded === true,
					},
					ctx,
				)
			: [];
		if (nested.length === 0) {
			// `use` is written as something that cannot be opened — a call, an
			// element access. That says the config sets `use`; it does not say what
			// is in it, and the layers below it are no longer the answer either.
			return { state: "unresolved", layer, node: initializer ?? property };
		}
		const read = readLayered(nested, (candidate) =>
			layerProperty(candidate, "testIdAttribute"),
		);
		if (read.state !== "absent") {
			return read;
		}
		// This layer writes `use` without the key. Skip everything its own object
		// replaces; resume at the first layer it merely merges into.
		let below = index;
		while (below > 0 && layers[below].useShallow) {
			below -= 1;
		}
		index = below;
	}
	return { state: "absent" };
}

export function originOf(layer: ConfigLayer): TestIdAttributeOrigin {
	switch (layer.origin) {
		case "primary":
			return "primary";
		case "merge-arg":
			return "merge-layer";
		case "imported-base":
			return "base-config";
		default:
			return "spread";
	}
}

/* -------------------------------------------------------------------------- */
/* Public reader                                                              */
/* -------------------------------------------------------------------------- */
