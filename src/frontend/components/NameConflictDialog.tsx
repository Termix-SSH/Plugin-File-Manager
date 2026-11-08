import React, { useId, useRef, useState } from "react";
import { Button, Checkbox, Label, PanePrompt } from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import type {
  ConflictAction,
  ConflictChoice,
  NameConflict,
} from "../lib/name-conflicts";

export function NameConflictDialog({
  conflict,
  onResolve,
}: {
  conflict: NameConflict;
  onResolve: (choice: ConflictChoice | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [applyToAll, setApplyToAll] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={container}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onResolve(null);
        } else if (event.key === "Tab") {
          const buttons =
            container.current?.querySelectorAll<HTMLButtonElement>("button");
          const first = buttons?.[0];
          const last = buttons?.[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <PanePrompt
        open
        className="[&>div:last-child]:flex-wrap"
        title={t("fileManager.nameConflictTitle")}
        description={t("fileManager.nameConflictDescription", {
          name: conflict.name,
        })}
        onCancel={() => onResolve(null)}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              autoFocus
              onClick={() => onResolve(null)}
            >
              {t("common.cancel")}
            </Button>
            {(["overwrite", "skip", "keep-both"] as ConflictAction[]).map(
              (action) => (
                <Button
                  key={action}
                  size="sm"
                  variant="outline"
                  onClick={() => onResolve({ action, applyToAll })}
                >
                  {t(`fileManager.conflict-${action}`)}
                </Button>
              ),
            )}
          </>
        }
      >
        <p className="text-xs text-muted-foreground">
          {t("fileManager.nameConflictHint")}
        </p>
        {conflict.remaining > 1 && (
          <div className="flex items-center gap-2 mt-3">
            <Checkbox
              id={id}
              checked={applyToAll}
              onCheckedChange={(checked) => setApplyToAll(checked === true)}
            />
            <Label htmlFor={id} className="text-xs">
              {t("fileManager.conflictApplyToAll")}
            </Label>
          </div>
        )}
      </PanePrompt>
    </div>
  );
}
