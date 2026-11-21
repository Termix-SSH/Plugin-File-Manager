import type { ReactNode } from "react";
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

export const LABEL =
  "text-[10px] font-bold uppercase tracking-widest text-muted-foreground";
export const SELECT =
  "flex h-8 w-full border border-border bg-(--field) px-3 py-1 text-xs outline-none focus:ring-1 focus:ring-ring";

/** This plugin's settings on the host form, and a setter for one key. */
export function useHostSettings(props: HostEditorSectionProps) {
  const mine =
    (props.form?.pluginSettings as Bag | undefined)?.[PLUGIN_ID] ?? {};
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
  return { mine, setSetting };
}

/** The login a protocol uses: typed in, a saved credential, or anonymous. */
export function ProtocolLogin({
  protocol,
  props,
  anonymousNoteKey,
  usernamePlaceholder,
}: {
  protocol: string;
  props: HostEditorSectionProps;
  anonymousNoteKey: string;
  usernamePlaceholder?: string;
}) {
  const { t } = useTranslation();
  const login: HostProtocolAuthForm = {
    ...EMPTY,
    ...((props.form?.protocolAuth as Logins | undefined)?.[protocol] ?? {}),
  };
  const credentials = (props.credentials ?? []) as Array<{
    id: string;
    name: string;
    username: string;
  }>;
  const setLogin = (patch: Partial<HostProtocolAuthForm>) =>
    props.updateForm((current) => {
      const bag = (current.protocolAuth as Logins | undefined) ?? {};
      return {
        protocolAuth: {
          ...bag,
          [protocol]: { ...EMPTY, ...bag[protocol], ...patch },
        },
      };
    });

  return (
    <SectionCard title={t("ftp.login")} icon={<Shield className="size-3.5" />}>
      <div className="flex flex-col gap-4 py-3">
        <div className="flex gap-2">
          {(["direct", "credential", "none"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={login.authType === m}
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
          <p className="text-xs text-muted-foreground">{t(anonymousNoteKey)}</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <label className={LABEL}>{t("ftp.username")}</label>
              <Input
                placeholder={usernamePlaceholder}
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
                onChange={(e) => setLogin({ password: e.target.value })}
              />
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className={LABEL}>{label}</label>
      {children}
    </div>
  );
}

export function WebdavHostSection(props: HostEditorSectionProps) {
  const { t } = useTranslation();
  const { mine, setSetting } = useHostSettings(props);
  const secure = mine.webdavHttps !== false;
  return (
    <>
      <SectionCard
        title={t("ftp.connection")}
        icon={<Globe className="size-3.5" />}
      >
        <div className="flex flex-col gap-4 py-3">
          <SettingRow
            label={t("webdav.https")}
            description={t("webdav.httpsDesc")}
          >
            <FakeSwitch
              checked={secure}
              onChange={(v) => setSetting("webdavHttps", v)}
            />
          </SettingRow>
          <Field label={t("ftp.port")}>
            <Input
              type="number"
              placeholder={secure ? "443" : "80"}
              value={mine.webdavPort ? Number(mine.webdavPort) : ""}
              onChange={(e) =>
                setSetting("webdavPort", Number(e.target.value) || 0)
              }
            />
          </Field>
          <Field label={t("webdav.path")}>
            <Input
              placeholder="/remote.php/dav/files/me"
              value={String(mine.webdavPath ?? "")}
              onChange={(e) => setSetting("webdavPath", e.target.value)}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            {t("webdav.pathHint")}
          </p>
          {secure && (
            <SettingRow
              label={t("ftp.allowSelfSigned")}
              description={t("ftp.allowSelfSignedDesc")}
            >
              <FakeSwitch
                checked={mine.webdavAllowSelfSigned === true}
                onChange={(v) => setSetting("webdavAllowSelfSigned", v)}
              />
            </SettingRow>
          )}
        </div>
      </SectionCard>
      <ProtocolLogin
        protocol="webdav"
        props={props}
        anonymousNoteKey="webdav.anonymousNote"
      />
    </>
  );
}

export function SmbHostSection(props: HostEditorSectionProps) {
  const { t } = useTranslation();
  const { mine, setSetting } = useHostSettings(props);
  return (
    <>
      <SectionCard
        title={t("ftp.connection")}
        icon={<Globe className="size-3.5" />}
      >
        <div className="flex flex-col gap-4 py-3">
          <Field label={t("smb.share")}>
            <Input
              placeholder="media"
              value={String(mine.smbShare ?? "")}
              onChange={(e) => setSetting("smbShare", e.target.value)}
            />
          </Field>
          <Field label={t("smb.domain")}>
            <Input
              placeholder="WORKGROUP"
              value={String(mine.smbDomain ?? "")}
              onChange={(e) => setSetting("smbDomain", e.target.value)}
            />
          </Field>
          <Field label={t("ftp.port")}>
            <Input
              type="number"
              placeholder="445"
              value={mine.smbPort ? Number(mine.smbPort) : ""}
              onChange={(e) =>
                setSetting("smbPort", Number(e.target.value) || 0)
              }
            />
          </Field>
          <p className="text-xs text-muted-foreground">{t("smb.limits")}</p>
        </div>
      </SectionCard>
      <ProtocolLogin
        protocol="smb"
        props={props}
        anonymousNoteKey="smb.guestNote"
      />
    </>
  );
}
