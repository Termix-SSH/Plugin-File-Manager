import { isWindowsSftpPath, sftpPathToLocalPath } from "./transfer-paths.js";

export interface DeleteCommand {
  command: string;
  commandWithSuccess: string;
}

export function quotePosixPath(path: string): string {
  return `'${path.replace(/'/g, "'\"'\"'")}'`;
}

/** Never let cp/mv interpret an existing destination as a containing folder. */
export function buildTransferCommand(
  operation: "copy" | "move",
  sourcePath: string,
  targetPath: string,
  overwrite: boolean,
): string {
  const source = quotePosixPath(sourcePath);
  const target = quotePosixPath(targetPath);
  const refuse = (message: string) => `echo '${message}' >&2; exit 1;`;
  const differentTypes = `{ [ -d ${source} ] && [ ! -d ${target} ]; } || { [ ! -d ${source} ] && [ -d ${target} ]; }`;
  const unsafeOverwrite = [
    `[ -L ${target} ]`,
    `[ ${source} -ef ${target} ]`,
    differentTypes,
    ...(operation === "move" ? [`[ -d ${target} ]`] : []),
  ].join(" || ");
  const guard = overwrite
    ? `if ${unsafeOverwrite}; then ${refuse("Cannot overwrite this item type, a link, the source itself, or an existing move directory; choose Keep both")} fi;`
    : refuse("Destination already exists; choose Overwrite or Keep both");
  const slash = targetPath.lastIndexOf("/");
  const parent = quotePosixPath(slash > 0 ? targetPath.slice(0, slash) : "/");
  // Refuse overlapping trees in either direction, including through aliases.
  const intoSelf = `if [ -d ${source} ]; then sd=$(cd -P -- ${source} && pwd -P) && td=$(cd -P -- ${parent} && pwd -P) || { echo 'Cannot resolve the source or destination folder' >&2; exit 1; }; case "$td/" in "$sd"/*) echo 'Cannot copy or move a folder into itself' >&2; exit 1;; esac; if [ -d ${target} ]; then tt=$(cd -P -- ${target} && pwd -P) || exit 1; case "$sd/" in "$tt"/*) echo 'Cannot copy a folder onto a folder that contains it' >&2; exit 1;; esac; fi; fi; `;
  const prefix = `if [ -e ${target} ] || [ -L ${target} ]; then ${guard} fi; ${intoSelf}`;
  // shortcut: requires cp/mv with -T and -n; add a checked alternative for BSD hosts.
  if (operation === "move") {
    return `${prefix}mv -${overwrite ? "f" : "n"}T -- ${source} ${target} && [ ! -e ${source} ] && [ ! -L ${source} ] && echo "SUCCESS"`;
  }
  // --remove-destination replaces nested links instead of writing through them.
  if (overwrite) {
    return `${prefix}cp -r --remove-destination -T -- ${source} ${target} && echo "COPY_SUCCESS"`;
  }
  // cp -n and mv -n exit 0 when the target appears mid-way, so copy to a
  // private sibling, publish it with a no-clobber mv and prove the temp is gone.
  const tmp = `${target}.termix-copy-$$`;
  return `${prefix}tmp=${tmp}; if [ -e "$tmp" ] || [ -L "$tmp" ]; then echo 'Temporary copy path already exists' >&2; exit 1; fi; if cp -r -T -- ${source} "$tmp" && mv -nT -- "$tmp" ${target} && [ ! -e "$tmp" ] && [ ! -L "$tmp" ]; then echo "COPY_SUCCESS"; else rm -rf -- "$tmp"; echo 'Destination already exists or the copy failed' >&2; exit 1; fi`;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildDeleteCommand(
  itemPath: string,
  isDirectory: boolean,
): DeleteCommand {
  if (isWindowsSftpPath(itemPath)) {
    const path = quotePowerShellLiteral(sftpPathToLocalPath(itemPath));
    const command = isDirectory
      ? `Remove-Item -LiteralPath ${path} -Recurse -Force -ErrorAction Stop`
      : `Remove-Item -LiteralPath ${path} -Force -ErrorAction Stop`;

    return {
      command,
      commandWithSuccess: `${command}; if ($?) { Write-Output "SUCCESS" }`,
    };
  }

  const path = quotePosixPath(itemPath);
  const command = isDirectory ? `rm -rf ${path}` : `rm -f ${path}`;

  return {
    command,
    commandWithSuccess: `${command} && echo "SUCCESS"`,
  };
}
