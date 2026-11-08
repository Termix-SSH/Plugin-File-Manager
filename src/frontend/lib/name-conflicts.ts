export type ConflictAction = "overwrite" | "skip" | "keep-both";
export type ConflictChoice = { action: ConflictAction; applyToAll: boolean };
export type NamedItem = { name: string; type: "file" | "directory" | "link" };
export type NameConflict = { name: string; remaining: number };
export type ConflictPrompt = (
  conflict: NameConflict,
) => Promise<ConflictChoice | null>;

export function uploadRoots(
  files: { relativePath: string }[],
  emptyDirs: string[],
) {
  const directories = new Set([
    ...files
      .filter((f) => f.relativePath.includes("/"))
      .map((f) => f.relativePath.split("/")[0]),
    ...emptyDirs.map((path) => path.split("/")[0]),
  ]);
  return [
    ...Array.from(directories, (name) => ({
      name,
      type: "directory" as const,
      index: -1,
    })),
    ...files.flatMap((f, index) =>
      f.relativePath.includes("/")
        ? []
        : [{ name: f.relativePath, type: "file" as const, index }],
    ),
  ];
}

export function uniqueName(
  item: NamedItem,
  occupied: ReadonlySet<string>,
): string {
  const dot = item.type === "file" ? item.name.lastIndexOf(".") : -1;
  const stem = dot > 0 ? item.name.slice(0, dot) : item.name;
  const extension = dot > 0 ? item.name.slice(dot) : "";
  let n = 1;
  let name = item.name;
  while (occupied.has(name)) name = `${stem} (${n++})${extension}`;
  return name;
}

/** Resolve before writing anything: dismissing a prompt cancels the whole plan. */
export async function resolveNameConflicts<T extends NamedItem>(
  items: T[],
  existing: NamedItem[],
  ask: ConflictPrompt,
  sameDirectoryCopy: (item: T) => boolean = () => false,
): Promise<
  { item: T; name: string; overwrite: boolean; existing?: NamedItem }[] | null
> {
  const occupied = new Map(existing.map((item) => [item.name, item]));
  const reserved = new Set([
    ...occupied.keys(),
    ...items.map((item) => item.name),
  ]);
  const seen = new Set(occupied.keys());
  let remaining = 0;
  for (const item of items) {
    if (seen.has(item.name) && !sameDirectoryCopy(item)) remaining++;
    seen.add(item.name);
  }
  let all: ConflictAction | undefined;
  const plan = [];
  for (const item of items) {
    const previous = occupied.get(item.name);
    let action: ConflictAction | undefined;
    if (sameDirectoryCopy(item)) action = "keep-both";
    else if (previous) {
      const choice = all
        ? { action: all, applyToAll: true }
        : await ask({ name: item.name, remaining });
      if (!choice) return null;
      action = choice.action;
      if (choice.applyToAll) all = action;
      remaining--;
    }
    if (action === "skip") continue;
    const name =
      action === "keep-both" ? uniqueName(item, reserved) : item.name;
    plan.push({
      item,
      name,
      overwrite: action === "overwrite",
      existing: previous,
    });
    occupied.set(name, { ...item, name });
    reserved.add(name);
  }
  return plan;
}

type UploadPlan = Awaited<
  ReturnType<typeof resolveNameConflicts<NamedItem & { index: number }>>
>;

/** Apply a plan for `uploadRoots` to the files/folders it was made from. */
export function applyUploadPlan<F extends { relativePath: string }>(
  files: F[],
  emptyDirs: string[],
  plan: NonNullable<UploadPlan>,
) {
  const directories = new Map(
    plan
      .filter(({ item }) => item.type === "directory")
      .map((entry) => [entry.item.name, entry] as const),
  );
  const looseFiles = new Map(
    plan
      .filter(({ item }) => item.type === "file")
      .map((entry) => [entry.item.index, entry] as const),
  );
  const remap = (path: string) => {
    const root = path.split("/")[0];
    const entry = directories.get(root);
    return entry ? entry.name + path.slice(root.length) : null;
  };
  return {
    files: files.flatMap((file, index) => {
      const nested = file.relativePath.includes("/");
      const entry = nested
        ? directories.get(file.relativePath.split("/")[0])
        : looseFiles.get(index);
      if (!entry) return [];
      return [
        {
          ...file,
          relativePath: nested ? remap(file.relativePath)! : entry.name,
          overwrite: entry.overwrite,
        },
      ];
    }),
    emptyDirs: emptyDirs.flatMap((path) => remap(path) ?? []),
  };
}
