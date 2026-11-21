import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { Button, Input, PanePrompt } from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { recentUsernames, validUsername } from "./lib/ask-username";

/** Asks who to log in as, for a host saved with the username "$ask". */
export function AskUsernamePrompt({
  open,
  hostId,
  hostName,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  hostId: number | string;
  hostName: string;
  onSubmit: (username: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const recent = recentUsernames(hostId);
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) setName(recentUsernames(hostId)[0] ?? "");
  }, [open, hostId]);

  const submit = () => {
    if (validUsername(name)) onSubmit(name.trim());
  };

  return (
    <PanePrompt
      open={open}
      icon={<UserRound className="size-4" />}
      title={t("fileManager.askUsername.title")}
      description={t("fileManager.askUsername.description", {
        host: hostName,
      })}
      onCancel={onCancel}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!validUsername(name)}
            onClick={submit}
          >
            {t("fileManager.askUsername.connect")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Input
          autoFocus
          value={name}
          className="h-8 font-mono"
          aria-label={t("fileManager.askUsername.title")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") submit();
          }}
        />
        {recent.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {recent.map((item) => (
              <Button
                key={item}
                variant="outline"
                size="xs"
                className="font-mono"
                onClick={() => setName(item)}
              >
                {item}
              </Button>
            ))}
          </div>
        )}
      </div>
    </PanePrompt>
  );
}
