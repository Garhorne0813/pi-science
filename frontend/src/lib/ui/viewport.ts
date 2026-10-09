// Tailwind md: starts at 768px.
export const MOBILE_MAX_WIDTH = 767;
export const NARROW_MEDIA_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;
export function isNarrowViewport(): boolean { return window.innerWidth <= MOBILE_MAX_WIDTH; }
