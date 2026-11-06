import {
  HOST_PROTOCOL_SECRET_KEPT,
  useTranslation,
  type HostEditorSectionProps,
  type HostProtocolAuthForm,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  FakeSwitch,
  Input,
  PasswordInput,
  SectionCard,
  Select2,
  SettingRow,
} from "@termix-ssh/plugin-sdk/ui";
import { Globe, Shield } from "lucide-react";

const PLUGIN_ID = "file-manager";

type Bag = Record<string, Record<string, unknown>>;
type Logins = Record<string, HostProtocolAuthForm>;

const EMPTY: HostProtocolAuthForm = {
  authType: "direct",
  credentialId: "",
  username: "",
  password: "",
  fields: {},
};

const LABEL =
  "text-[10px] font-bold uppercase tracking-widest text-muted-foreground";
const SELECT =
  "flex h-9 w-full border border-border bg-background px-3 py-1 text-xs outline-none focus:ring-1 focus:ring-ring";

export function FtpHostSection(props: HostEditorSectionProps) {
  const { t } = useTranslation();
  const mine =
    (props.form?.pluginSettings as Bag | undefined)?.[PLUGIN_ID] ?? {};
  const login: HostProtocolAuthForm = {
    ...EMPTY,
    ...((props.form?.protocolAuth as Logins | undefined)?.ftp ?? {}),
  };
  const credentials = (props.credentials ?? []) as Array<{
    id: string;
    name: string;
    username: string;
  }>;
  const secure = String(mine.ftpSecure ?? "none");

  const setSetting = (key: string, value: unknown) =>
    props.updateForm((current) => {
      const bag = (current.pluginSettings as Bag | undefined) ?? {};
      return {
        pluginSettings: {
          ...bag,
          [PLUGIN_ID]: { ...(bag[PLUGIN_ID] ?? {}), [key]: value },
        },
      };
    });

  const setLogin = (patch: Partial<HostProtocolAuthForm>) =>
    props.updateForm((current) => {
      const bag = (current.protocolAuth as Logins | undefined) ?? {};
      return {
        protocolAuth: { ...bag, ftp: { ...EMPTY, ...bag.ftp, ...patch } },
      };
    });

  return (
    <>
      <SectionCard
        title={t("ftp.connection")}
        icon={<Globe className="size-3.5" />}
      >
        <div className="flex flex-col gap-4 py-3">
          <div className="flex flex-col gap-1.5">
            <label className={LABEL}>{t("ftp.port")}</label>
            <Input
              type="number"
              placeholder="21"
              value={Number(mine.ftpPort ?? 21)}
              onChange={(e) => setSetting("ftpPort", Number(e.target.value))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={LABEL}>{t("ftp.security")}</label>
            <Select2
              value={secure}
              onChange={(e) => setSetting("ftpSecure", e.target.value)}
              className={SELECT}
            >
              <option value="none">{t("ftp.securityNone")}</option>
              <option value="explicit">{t("ftp.securityExplicit")}</option>
              <option value="implicit">{t("ftp.securityImplicit")}</option>
            </Select2>
          </div>
          {secure !== "none" && (
            <SettingRow
              label={t("ftp.allowSelfSigned")}
              description={t("ftp.allowSelfSignedDesc")}
            >
              <FakeSwitch
                checked={mine.ftpAllowSelfSigned === true}
                onChange={(v) => setSetting("ftpAllowSelfSigned", v)}
              />
            </SettingRow>
          )}
        </div>
      </SectionCard>
      <SectionCard
        title={t("ftp.login")}
        icon={<Shield className="size-3.5" />}
      >
        <div className="flex flex-col gap-4 py-3">
          <div className="flex gap-2">
            {(["direct", "credential", "none"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setLogin({ authType: m })}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest border transition-colors ${
                  login.authType === m
                    ? "border-accent-brand/40 bg-accent-brand/10 text-accent-brand"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {t(`ftp.auth.${m}`)}
              </button>
            ))}
          </div>
          {login.authType === "credential" ? (
            <Select2
              value={login.credentialId}
              onChange={(e) => setLogin({ credentialId: e.target.value })}
              className={SELECT}
            >
              <option value="">{t("ftp.selectCredential")}</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.username ? `${c.name} (${c.username})` : c.name}
                </option>
              ))}
            </Select2>
          ) : login.authType === "none" ? (
            <p className="text-xs text-muted-foreground">
              {t("ftp.anonymousNote")}
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className={LABEL}>{t("ftp.username")}</label>
                <Input
                  placeholder="anonymous"
                  value={login.username}
                  onChange={(e) => setLogin({ username: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className={LABEL}>{t("ftp.password")}</label>
                <PasswordInput
                  className="h-8 text-xs pr-8"
                  placeholder={
                    login.password === HOST_PROTOCOL_SECRET_KEPT
                      ? t("ftp.passwordSaved")
                      : "••••••••"
                  }
                  value={
                    login.password === HOST_PROTOCOL_SECRET_KEPT
                      ? ""
                      : login.password
                  }
                  onFocus={() => {
                    if (login.password === HOST_PROTOCOL_SECRET_KEPT)
                      setLogin({ password: "" });
                  }}
                  onChange={(e) => setLogin({ password: e.target.value })}
                />
              </div>
            </div>
          )}
        </div>
      </SectionCard>
    </>
  );
}
