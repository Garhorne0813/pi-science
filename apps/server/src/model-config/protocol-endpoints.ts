/** Anthropic SDK appends /v1 itself; accept either common user-facing base form. */
export const anthropicBaseUrl = (url: string) => url.replace(/\/+$/, "").replace(/\/v1$/, "");
