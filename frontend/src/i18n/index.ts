import i18next from "i18next";
import { initReactI18next } from "react-i18next";

const resources: Record<string, { translation: Record<string, string> }> = {
  en: {
    translation: {
      // Common
      "common.close": "Close",
      "common.cancel": "Cancel",
      "common.ok": "OK",
      "common.loading": "Loading…",
      "common.error": "Error",
      // Inspector
      "inspector.title": "Inspector",
      "inspector.loading": "Loading preview…",
      "inspector.error": "Failed to load preview",
      "inspector.noPreview": "Preview not available",
      "inspector.fileTooLarge": "File too large to preview",
      "inspector.unknownFormat": "Unknown format",
      "inspector.rawData": "Raw data",
      "inspector.download": "Download",
      "inspector.openExternally": "Open externally",
      "inspector.copyPath": "Copy path",
      // Session
      "session.send": "Send",
      "session.stop": "Stop",
      "session.thinking": "Thinking…",
    },
  },
  "zh-Hans": {
    translation: {
      "common.close": "关闭",
      "common.cancel": "取消",
      "common.ok": "确定",
      "common.loading": "加载中…",
      "common.error": "错误",
      "inspector.title": "检查器",
      "inspector.loading": "正在加载预览…",
      "inspector.error": "加载预览失败",
      "inspector.noPreview": "预览不可用",
      "session.send": "发送",
      "session.stop": "停止",
      "session.thinking": "思考中…",
    },
  },
};

i18next.use(initReactI18next).init({
  resources,
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export { i18next };
export const i18n = i18next;
export default i18next;
