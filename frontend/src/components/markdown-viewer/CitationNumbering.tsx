import { createContext, useContext, type ReactNode } from "react";
import type { CitationNumbering } from "../../lib/citations";

const CitationNumberingContext = createContext<CitationNumbering | null>(null);

/** The numbering of the document being rendered. A body marker reads it here,
 *  so the identifier text the model wrote stays untouched and the number comes
 *  from the one map the reference list also reads. */
export function CitationNumberingProvider({ numbering, children }: { numbering: CitationNumbering | null; children: ReactNode }) {
  return <CitationNumberingContext.Provider value={numbering}>{children}</CitationNumberingContext.Provider>;
}

export function useCitationNumbering(): CitationNumbering | null {
  return useContext(CitationNumberingContext);
}
