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
  return files
    .filter((file) => !q || file.name.toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      let result = 0;
      switch (sortBy) {
        case "name":
          result = collator.compare(a.name, b.name);
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
