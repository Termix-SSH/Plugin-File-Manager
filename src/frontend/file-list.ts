import type { FileItem } from "./host-types";

export type SortBy = "name" | "modified" | "size";

/** Filters by name substring, directories first, then sorts. Returns a new array. */
export function filterAndSortFiles(
  files: FileItem[],
  searchQuery: string,
  sortBy: SortBy,
  sortOrder: "asc" | "desc",
): FileItem[] {
  const q = searchQuery.toLowerCase();
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  const plain = new Intl.Collator(undefined, { sensitivity: "base" });
  // Natural order (a2 before a10) only helps names of different length. Names
  // of the same length, like zero padded or hex ones (WAL files), sort char by
  // char, or 12A would land before 129.
  const byName = (a: string, b: string) =>
    a.length === b.length ? plain.compare(a, b) : collator.compare(a, b);
  return files
    .filter((file) => !q || file.name.toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      let result = 0;
      switch (sortBy) {
        case "name":
          result = byName(a.name, b.name);
          break;
        case "modified":
          result = (a.modifiedTimestamp || 0) - (b.modifiedTimestamp || 0);
          break;
        case "size":
          result = (a.size || 0) - (b.size || 0);
          break;
      }
      return sortOrder === "desc" ? -result : result;
    });
}
