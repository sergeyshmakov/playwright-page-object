import type { Page } from "@playwright/test";

type AnyCtor = abstract new (...args: any[]) => object;
type PageFirst<T extends AnyCtor> = ConstructorParameters<T> extends [Page, ...unknown[]] ? T : never;

declare function deco(): <T extends AnyCtor>(target: PageFirst<T>, context: ClassDecoratorContext<T>) => T;

@deco()
class A {}

@deco()
class B { constructor(page: Page) {} }
