import { ResourceList } from "../../src/resource-list";

export default function Libraries() {
  return (
    <ResourceList
      params={{ scope: "libraries", kind: "library", sort: "updated_at", order: "desc" }}
      empty="还没有知识库"
    />
  );
}
