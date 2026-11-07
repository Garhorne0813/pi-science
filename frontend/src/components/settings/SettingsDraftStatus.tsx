import { createContext, useContext, useEffect } from "react";
export const SettingsDraftContext = createContext<(section: string, dirty: boolean) => void>(() => {});
export function useSettingsDraftStatus(section: string, dirty: boolean) {
  const report = useContext(SettingsDraftContext);
  useEffect(() => { report(section, dirty); return () => report(section, false); }, [report, section, dirty]);
}
