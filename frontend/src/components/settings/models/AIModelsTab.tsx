import { NativeModelSettings } from "./NativeModelSettings";

export interface AIModelsTabProps {
  scope?: string | null;
  apiKeyInput: Record<string, string>;
  setApiKeyInput: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  showKey: Record<string, boolean>;
  setShowKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  saving: string | null;
  saveKey: (provider: string) => Promise<void>;
  deleteKey: (provider: string) => Promise<void>;
  onConfigReload?: () => Promise<void>;
}

export function AIModelsTab(props: AIModelsTabProps) {
  return <NativeModelSettings onConfigReload={props.onConfigReload} />;
}
