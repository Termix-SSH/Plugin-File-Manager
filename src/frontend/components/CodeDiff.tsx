import React, { useEffect, useRef } from "react";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { getLanguageExtension } from "./CodeEditor.tsx";

interface CodeDiffProps {
  fileName: string;
  original: string;
  modified: string;
  sideBySide: boolean;
  showLineNumbers: boolean;
}

const fill = EditorView.theme({
  "&": { height: "100%", fontSize: "13px" },
  ".cm-scroller": { overflow: "auto" },
});

/** Read only diff of two files, bundled with the plugin. */
export function CodeDiff({
  fileName,
  original,
  modified,
  sideBySide,
  showLineNumbers,
}: CodeDiffProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const language = getLanguageExtension(fileName);
    const extensions: Extension[] = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      oneDark,
      fill,
    ];
    if (language) extensions.push(language);
    if (showLineNumbers) extensions.push(lineNumbers());

    if (sideBySide) {
      const view = new MergeView({
        a: { doc: original, extensions },
        b: { doc: modified, extensions },
        parent,
        gutter: true,
      });
      view.dom.style.height = "100%";
      view.dom.style.overflow = "auto";
      return () => view.destroy();
    }
    const view = new EditorView({
      doc: modified,
      extensions: [
        ...extensions,
        unifiedMergeView({ original, mergeControls: false }),
      ],
      parent,
    });
    return () => view.destroy();
  }, [fileName, original, modified, sideBySide, showLineNumbers]);

  return <div ref={host} className="h-full min-h-0" data-testid="code-diff" />;
}
