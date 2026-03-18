import type { Locator, Page } from "@playwright/test";
import { vi } from "vitest";

export type MockLocator = Locator & {
	getByTestId: ReturnType<typeof vi.fn>;
	getByText: ReturnType<typeof vi.fn>;
	getByRole: ReturnType<typeof vi.fn>;
	getByLabel: ReturnType<typeof vi.fn>;
	getByPlaceholder: ReturnType<typeof vi.fn>;
	getByAltText: ReturnType<typeof vi.fn>;
	getByTitle: ReturnType<typeof vi.fn>;
	nth: ReturnType<typeof vi.fn>;
	filter: ReturnType<typeof vi.fn>;
	locator: ReturnType<typeof vi.fn>;
	first: ReturnType<typeof vi.fn>;
	click: ReturnType<typeof vi.fn>;
	dblclick: ReturnType<typeof vi.fn>;
	hover: ReturnType<typeof vi.fn>;
	fill: ReturnType<typeof vi.fn>;
	clear: ReturnType<typeof vi.fn>;
	check: ReturnType<typeof vi.fn>;
	uncheck: ReturnType<typeof vi.fn>;
	press: ReturnType<typeof vi.fn>;
	count: ReturnType<typeof vi.fn>;
	page: ReturnType<typeof vi.fn>;
};

export type MockPage = Page & {
	locator: ReturnType<typeof vi.fn>;
	getByTestId: ReturnType<typeof vi.fn>;
};

export function createMockLocator(page?: Page): MockLocator {
	const mockLocator = {
		getByTestId: vi.fn().mockImplementation(() => createMockLocator(page)),
		getByText: vi.fn().mockImplementation(() => createMockLocator(page)),
		getByRole: vi.fn().mockImplementation(() => createMockLocator(page)),
		getByLabel: vi.fn().mockImplementation(() => createMockLocator(page)),
		getByPlaceholder: vi.fn().mockImplementation(() => createMockLocator(page)),
		getByAltText: vi.fn().mockImplementation(() => createMockLocator(page)),
		getByTitle: vi.fn().mockImplementation(() => createMockLocator(page)),
		locator: vi.fn().mockImplementation(() => createMockLocator(page)),
		first: vi.fn().mockImplementation(() => createMockLocator(page)),
		nth: vi.fn().mockImplementation(() => createMockLocator(page)),
		filter: vi.fn().mockImplementation(() => createMockLocator(page)),
		click: vi.fn().mockResolvedValue(undefined),
		dblclick: vi.fn().mockResolvedValue(undefined),
		hover: vi.fn().mockResolvedValue(undefined),
		fill: vi.fn().mockResolvedValue(undefined),
		clear: vi.fn().mockResolvedValue(undefined),
		check: vi.fn().mockResolvedValue(undefined),
		uncheck: vi.fn().mockResolvedValue(undefined),
		press: vi.fn().mockResolvedValue(undefined),
		count: vi.fn().mockResolvedValue(0),
		page: vi.fn().mockReturnValue(page ?? undefined),
	};

	return mockLocator as MockLocator;
}

export function createMockPage(): MockPage {
	const bodyLocator = createMockLocator();
	const mockPage = {
		locator: vi.fn().mockReturnValue(bodyLocator),
		getByTestId: vi.fn().mockImplementation(() => createMockLocator()),
	};
	bodyLocator.page = vi.fn().mockReturnValue(mockPage);
	return mockPage as MockPage;
}
