type T = (key: string) => string;

/**
 * The delete question: Move to Trash, or with Delete permanently ticked,
 * delete for good. The text follows the checkbox.
 */
export function deletePrompt(
  t: T,
  title: string,
  permanent: boolean,
  onChange: (checked: boolean) => void,
) {
  return {
    title,
    description: t("fileManager.moveToTrashWarning"),
    confirmLabel: t("fileManager.moveToTrash"),
    checkbox: {
      label: t("fileManager.deletePermanently"),
      checked: permanent,
      onChange,
      checkedDescription: t("fileManager.deletePermanentlyWarning"),
      checkedConfirmLabel: t("fileManager.deletePermanently"),
    },
  };
}
