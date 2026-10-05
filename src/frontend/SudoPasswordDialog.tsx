import React, { useState, useEffect } from "react";
import { Button, PanePrompt, PasswordInput } from "@termix-ssh/plugin-sdk/ui";
import { Shield } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";

interface SudoPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (password: string) => void;
}

export function SudoPasswordDialog({
  open,
  onOpenChange,
  onSubmit,
}: SudoPasswordDialogProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setPassword("");
      setLoading(false);
    }
  }, [open]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
    }

    if (!password.trim()) {
      return;
    }

    setLoading(true);
    onSubmit(password);
  };

  return (
    <PanePrompt
      open={open}
      icon={<Shield className="size-4" />}
      title={t("fileManager.sudoPasswordRequired")}
      description={t("fileManager.enterSudoPassword")}
      onCancel={() => onOpenChange(false)}
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!password.trim() || loading}
            variant="outline"
            className="border-accent-brand/40 text-accent-brand hover:bg-accent-brand/10"
            onClick={() => void handleSubmit()}
          >
            {loading ? t("common.loading") : t("common.confirm")}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit}>
        <PasswordInput
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("fileManager.sudoPassword")}
          autoFocus
          disabled={loading}
        />
      </form>
    </PanePrompt>
  );
}
