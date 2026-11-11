/**
 * How many questions one ask_user_question invocation may carry. This is the
 * single source of truth for the tool JSON Schema, the runtime validation and
 * the control-plane questionnaire projection, so all three cannot disagree.
 */
export const MAX_QUESTIONS = 20;
