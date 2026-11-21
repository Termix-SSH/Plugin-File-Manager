import { describe, expect, it, vi } from "vitest";
import { deletePrompt } from "../../../src/frontend/lib/delete-prompt";

describe("delete prompt", () => {
  it("offers the trash with a Delete permanently checkbox", () => {
    const onChange = vi.fn();
    const prompt = deletePrompt((key) => key, "Delete a?", false, onChange);
    expect(prompt).toMatchObject({
      title: "Delete a?",
      description: "fileManager.moveToTrashWarning",
      confirmLabel: "fileManager.moveToTrash",
      checkbox: {
        label: "fileManager.deletePermanently",
        checked: false,
        checkedDescription: "fileManager.deletePermanentlyWarning",
        checkedConfirmLabel: "fileManager.deletePermanently",
      },
    });
    prompt.checkbox.onChange(true);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("starts ticked for Shift+Delete", () => {
    expect(
      deletePrompt(
        (key) => key,
        "x",
        true,
        () => {},
      ).checkbox.checked,
    ).toBe(true);
  });
});
