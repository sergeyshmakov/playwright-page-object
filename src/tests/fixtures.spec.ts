import { describe, expect, it, vi } from "vitest";
import { createFixtures } from "../fixtures";
import { PageObject } from "../page-objects/PageObject";
import { createMockPage } from "./mocks/playwright";

type FixtureFn = (
	args: { page: unknown },
	use: (r: unknown) => Promise<void>,
) => Promise<void>;

function invokeFixture(
	fixture: unknown,
	args: { page: unknown },
	use: (r: unknown) => Promise<void>,
) {
	const fn = Array.isArray(fixture) ? fixture[0] : fixture;
	return (fn as FixtureFn)(args, use);
}

describe("createFixtures", () => {
	it("creates fixture per key", () => {
		class HomePage extends PageObject {}
		class LoginPage extends PageObject {}

		const fixtures = createFixtures({
			homePage: HomePage,
			loginPage: LoginPage,
		});

		expect(fixtures.homePage).toBeDefined();
		expect(fixtures.loginPage).toBeDefined();
		expect(typeof fixtures.homePage).toBe("function");
	});

	it("fixture receives page and use", async () => {
		class TestPage extends PageObject {}

		const fixtures = createFixtures({ testPage: TestPage });
		const mockPage = createMockPage();
		const testPageFixture = fixtures.testPage;
		if (!testPageFixture) throw new Error("testPage fixture missing");

		const use = vi.fn().mockResolvedValue(undefined);
		await invokeFixture(testPageFixture, { page: mockPage }, use);

		expect(use).toHaveBeenCalled();
	});

	it("fixture instantiates with page", async () => {
		class TestPage extends PageObject {}

		const fixtures = createFixtures({ testPage: TestPage });
		const mockPage = createMockPage();
		const testPageFixture = fixtures.testPage;
		if (!testPageFixture) throw new Error("testPage fixture missing");

		const use = vi.fn().mockResolvedValue(undefined);
		await invokeFixture(testPageFixture, { page: mockPage }, use);

		const instance = use.mock.calls[0][0];
		expect(instance).toBeInstanceOf(TestPage);
		expect(instance.page).toBe(mockPage);
	});

	it("use() receives instance", async () => {
		class TestPage extends PageObject {}

		const fixtures = createFixtures({ testPage: TestPage });
		const mockPage = createMockPage();
		const testPageFixture = fixtures.testPage;
		if (!testPageFixture) throw new Error("testPage fixture missing");

		let receivedInstance: PageObject | undefined;
		const use = vi.fn().mockImplementation(async (instance: PageObject) => {
			receivedInstance = instance;
		});

		await invokeFixture(testPageFixture, { page: mockPage }, use);

		expect(receivedInstance).toBeInstanceOf(TestPage);
		expect(receivedInstance?.page).toBe(mockPage);
	});

	it("use() is awaited", async () => {
		class TestPage extends PageObject {}

		const fixtures = createFixtures({ testPage: TestPage });
		const mockPage = createMockPage();
		const testPageFixture = fixtures.testPage;
		if (!testPageFixture) throw new Error("testPage fixture missing");

		let useCompleted = false;
		const use = vi.fn().mockImplementation(async () => {
			useCompleted = true;
		});

		await invokeFixture(testPageFixture, { page: mockPage }, use);

		expect(useCompleted).toBe(true);
		expect(use).toHaveBeenCalled();
	});
});
