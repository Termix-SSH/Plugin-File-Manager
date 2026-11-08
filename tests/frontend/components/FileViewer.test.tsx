import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileViewer } from "../../../src/frontend/components/FileViewer";

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@termix-ssh/plugin-sdk/frontend")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe("FileViewer markdown editing", () => {
  it("saves with Ctrl+S while the markdown textarea is focused", () => {
    const onSave = vi.fn();
    const onContentChange = vi.fn();
    const { getByText, getByPlaceholderText } = render(
      <FileViewer
        file={{ name: "notes.md", path: "/notes.md", type: "file" }}
        content="# hi"
        savedContent="# hi"
        isEditable
        onSave={onSave}
        onContentChange={onContentChange}
      />,
    );

    fireEvent.click(getByText("fileManager.edit"));
    const area = getByPlaceholderText("fileManager.startWritingMarkdown");
    area.focus();
    fireEvent.change(area, { target: { value: "# changed" } });
    fireEvent.keyDown(area, { key: "s", ctrlKey: true });

    expect(onContentChange).toHaveBeenCalledWith("# changed");
    expect(onSave).toHaveBeenCalledWith("# changed");
  });
});
