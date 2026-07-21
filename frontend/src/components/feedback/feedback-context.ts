import { createContext, useContext } from "react";

export type ToastTone = "success" | "error" | "info";
export type ConfirmOptions = { title: string; message: string; confirmLabel?: string; destructive?: boolean };

export interface FeedbackApi {
  toast: (message: string, tone?: ToastTone) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

export const FeedbackContext = createContext<FeedbackApi | null>(null);

export function useFeedback(): FeedbackApi {
  const value = useContext(FeedbackContext);
  if (!value) throw new Error("useFeedback must be used inside FeedbackProvider");
  return value;
}
