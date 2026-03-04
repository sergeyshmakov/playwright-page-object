import { describe, expect, it } from "vitest";
import { prop } from "../../utils/helpers";

describe("prop()", () => {
    it("returns data-prop-{name} with lowercase name", () => {
        expect(prop("Foo")).toBe("data-prop-foo");
    });

    it("handles empty string", () => {
        expect(prop("")).toBe("data-prop-");
    });

    it("handles mixed case", () => {
        expect(prop("MyProp")).toBe("data-prop-myprop");
    });
});
