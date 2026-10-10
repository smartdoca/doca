import { lazy, type ComponentProps } from "react";
import { LazyContent } from "@web/shared/components/lazy-content.js";

const Graph = lazy(() =>
  import("./book-graph.js").then((module) => ({ default: module.BookGraph })),
);

export function BookGraph(props: ComponentProps<typeof Graph>) {
  return (
    <LazyContent>
      <Graph {...props} />
    </LazyContent>
  );
}
