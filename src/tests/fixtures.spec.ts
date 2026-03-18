import { describe, expect, it, vi } from "vitest";
import { createFixtures } from "../fixtures";
import { RootPageObject } from "../page-objects/RootPageObject";
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
	function getFixture(fixture: unknown) {
		if (!fixture) {
			throw new Error("Expected fixture to be defined");
		}
		return fixture;
	}

	it("creates fixture per key", () => {
		class HomePage extends RootPageObject {}
		class LoginPage extends RootPageObject {}

		const fixtures = createFixtures({
			homePage: HomePage,
			loginPage: LoginPage,
		});

		expect(fixtures.homePage).toBeDefined();
		expect(fixtures.loginPage).toBeDefined();
		expect(typeof fixtures.homePage).toBe("function");
	});

	it("fixture receives page and use", async () => {
		class TestPage extends RootPageObject {}

		const fixtures = createFixtures({ testPage: TestPage });
		const mockPage = createMockPage();

		const use = vi.fn().mockResolvedValue(undefined);
		await invokeFixture(getFixture(fixtures.testPage), { page: mockPage }, use);

		expect(use).toHaveBeenCalled();
	});

	it("fixture instantiates with page", async () => {
		class TestPage extends RootPageObject {}

		const fixtures = createFixtures({ testPage: TestPage });
		const mockPage = createMockPage();

		const use = vi.fn().mockResolvedValue(undefined);
		await invokeFixture(getFixture(fixtures.testPage), { page: mockPage }, use);

		const instance = use.mock.calls[0][0];
		expect(instance).toBeInstanceOf(TestPage);
		expect(instance.page).toBe(mockPage);
	});

	it("use() receives instance", async () => {
		class TestPage extends RootPageObject {}

		const fixtures = createFixtures({ testPage: TestPage });
		const mockPage = createMockPage();

		let receivedInstance: RootPageObject | undefined;
		const use = vi.fn().mockImplementation(async (instance: RootPageObject) => {
			receivedInstance = instance;
		});

		await invokeFixture(getFixture(fixtures.testPage), { page: mockPage }, use);

		expect(receivedInstance).toBeInstanceOf(TestPage);
		expect(receivedInstance?.page).toBe(mockPage);
	});

	it("use() is awaited", async () => {
		class TestPage extends RootPageObject {}

		const fixtures = createFixtures({ testPage: TestPage });
		const mockPage = createMockPage();

		let useCompleted = false;
		const use = vi.fn().mockImplementation(async () => {
			useCompleted = true;
		});

		await invokeFixture(getFixture(fixtures.testPage), { page: mockPage }, use);

		expect(useCompleted).toBe(true);
		expect(use).toHaveBeenCalled();
	});
});
