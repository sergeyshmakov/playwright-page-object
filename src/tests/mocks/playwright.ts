import { vi } from "vitest";

export type MockLocator = ReturnType<typeof createMockLocator>;
export type MockPage = ReturnType<typeof createMockPage>;

export function createMockLocator(page?: unknown) {
	const mockLocator = {
		getByTestId: vi.fn().mockImplementation(() => createMockLocator(page)),
		getByText: vi.fn().mockImplementation(() => createMockLocator(page)),
		getByRole: vi.fn().mockImplementation(() => createMockLocator(page)),
		getByLabel: vi.fn().mockImplementation(() => createMockLocator(page)),
		getByPlaceholder: vi.fn().mockImplementation(() => createMockLocator(page)),
		getByAltText: vi.fn().mockImplementation(() => createMockLocator(page)),
		getByTitle: vi.fn().mockImplementation(() => createMockLocator(page)),
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

	return mockLocator;
}

export function createMockPage() {
	const bodyLocator = createMockLocator();
	const mockPage = {
		locator: vi.fn().mockReturnValue(bodyLocator),
		getByTestId: vi.fn().mockImplementation(() => createMockLocator()),
	};
	bodyLocator.page = vi.fn().mockReturnValue(mockPage);
	return mockPage;
}
