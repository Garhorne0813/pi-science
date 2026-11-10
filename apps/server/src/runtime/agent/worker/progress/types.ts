/** One progress source. An adapter turns a stream of output text into
 *  observations of named work scopes. It never decides what the UI shows, and
 *  it never writes a percentage. Adapters validate through the contracts
 *  normalizer, so a bad observation degrades instead of rendering. */

/** What an adapter reports. Everything numeric is a measurement the producing
 *  library published, in its own words. */
export interface ProgressObservation {
  /** Scope name inside the adapter. The collector namespaces it so two
   *  adapters cannot collide on one id. Keep it short and stable: two
   *  observations with one scope id are two measurements of one thing. */
  readonly scopeId: string;
  /** Plain text naming the work the number counts. */
  readonly scopeLabel: string;
  readonly current?: number;
  readonly total?: number;
  /** A share the producer printed next to a denominator it did not print, such
   *  as `pv`'s own `45%`. Reported as published; the contract decides whether it
   *  can be shown. */
  readonly percent?: number;
  /** `fixed` only when the producer published a real denominator. A total it
   *  may revise is `reestimated`, and a total it never published is `unknown`. */
  readonly totalKind?: "fixed" | "reestimated" | "unknown";
  readonly unit?: string;
  readonly phase?: string;
  readonly label?: string;
  readonly indeterminate?: boolean;
}

export interface ProgressAdapter {
  /** Namespace for this adapter's scopes, also the switch that turns it off. */
  readonly id: string;
  /** Whether the adapter may read this command. An adapter without this
   *  method reads every command. A tool-specific adapter earns its match from
   *  the command text, so a plain `50%` elsewhere on the system is not read as
   *  a progress report. */
  matches?(command: string): boolean;
  /** Structured records live in control lines that the visible output drops,
   *  so such an adapter must read the uncleaned text. */
  readonly readsControlLines?: boolean;
  /** Observations found in the output so far, oldest first. Read from the whole
   *  accumulated text, which makes a chunk boundary or a repeated read
   *  harmless, and return only records the producer finished writing. */
  read(text: string): readonly ProgressObservation[];
}
