/** The quote block a user message carries. A quote is a value copied out of an
 *  earlier message, so the model reads the text with no server lookup and the
 *  transcript can show exactly what was sent. Kept free of store imports so the
 *  message-text helpers can use it without closing an import cycle. */

export type MessageQuoteRole = "user" | "agent";
export type MessageQuoteKind = "message" | "selection";

export interface QuotedMessageBlock { role: MessageQuoteRole; kind: MessageQuoteKind; text: string }

export interface QuotedMessageSource { source: { role: MessageQuoteRole; blockId: string }; kind: MessageQuoteKind; text: string }

/** The closing tag must sit alone on a line. A quoted message that itself has the
 *  tag on its own line ends the block there, which shortens the transcript
 *  preview only: the model still receives the sent message verbatim. */
const QUOTE_BLOCK = /<quoted_message role="(user|agent)" kind="(message|selection)">\n([\s\S]*?)\n<\/quoted_message>/g;

export function quotedMessageBlock(quote: QuotedMessageSource): string {
  return `<quoted_message role="${quote.source.role}" kind="${quote.kind}">\n${quote.text}\n</quoted_message>`;
}

/** The prompt the model receives: the full quoted text with its source role and
 *  the user's own question. Nothing here shortens the quote, because a truncated
 *  quote asks the model about text the user never selected. */
export function composeQuotedPrompt(quote: QuotedMessageSource, question: string): string {
  const block = quotedMessageBlock(quote);
  return question ? `${block}\n\n${question}` : block;
}

export function quotedMessagesFromMessage(message: string): QuotedMessageBlock[] {
  return [...message.matchAll(QUOTE_BLOCK)].map((match) => ({ role: match[1] as MessageQuoteRole, kind: match[2] as MessageQuoteKind, text: match[3]! }));
}

export function stripQuotedMessageBlocks(message: string): string {
  return message.replace(QUOTE_BLOCK, "").trim();
}

/** The DOM id of the message a quote came from. Both renderers use it, so the
 *  composer can locate the source without knowing which one drew it. */
export function messageAnchorId(source: { blockId: string; role: MessageQuoteRole }): string {
  return `${source.role}-msg-${source.blockId}`;
}
